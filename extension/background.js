// Pund-IT Meeting Assistant Auto-Record — MV3 service worker.
// Owns meeting state across tabs, talks to the local Pund-IT Meeting Assistant trigger server, alarms keep-alive.
// v1.3 (PUN-801): SENSOR architecture. Content scripts no longer run detection state
// machines — every frame (top AND subframes) beams raw signals every 2s; the worker
// merges them per tab and decides join/leave. Fixes the split-frame case where Meet's
// video/controls render in a subframe whose URL fails the meeting-path test (top frame
// had the URL but no UI, subframe had the UI but no meeting URL — neither could fire).
// Also adds: frame-routed debug/census collection, force-start (context menu +
// options toggle) as a DOM-free, audio-free trigger, and heartbeat ownership.
const DEFAULT_PORT = 7788;
const JOIN_CONFIRM_MS = 3000;    // merged meeting-ish signals must persist this long
const LEAVE_DEBOUNCE_MS = 8000;  // all-fresh-frames-dark before stopping
const FRAME_STALE_MS = 150000;    // frame beacon older than this = frame gone/throttled
                                 // (hidden tabs throttle to ~1 beacon/min — 70s tore
                                 // meetings down whenever the tab was backgrounded)
const GONE_SILENCE_MS = 240000;  // no beacon at all from an in-meeting tab => left
                                 // (tab throttling can slow beacons to ~60s; this must
                                 // also land before the app's 5-min heartbeat deadman)
const HEARTBEAT_SEND_MS = 12000; // worker-side heartbeat throttle
const ALARM_HEARTBEAT = 'meetily-hb';
const DOMAIN_RE =
  /(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft|([a-z0-9-]+\.)*zoom\.us)$/i;
const TEAMS_HOST_RE = /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft)$/i;

// Teams SPA tabs may remain open across extension reloads and have no content
// script until navigation. On worker startup, explicitly inspect/inject Teams
// only; Google Meet's existing manifest-driven path remains unchanged.
async function discoverOpenTeamsTabs(reason) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*', 'https://m365.cloud.microsoft/*'] }); }
  catch (e) { dbg(`Teams tab discovery query failed (${reason}): ${e}`); return; }
  dbg(`Teams tab discovery (${reason}): ${tabs.length} matching tab(s)`);
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch (_) { continue; }
    if (!TEAMS_HOST_RE.test(host)) continue;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      dbg(`[tab ${tab.id}] Teams diagnostic injection requested; frames=${results?.length ?? 0} url=${tab.url.slice(0, 100)}`);
    } catch (e) {
      dbg(`[tab ${tab.id}] Teams content-script injection failed: ${e && e.message ? e.message : e}`);
    }
  }
}
chrome.runtime.onInstalled.addListener(() => { void discoverOpenTeamsTabs('onInstalled'); });
chrome.runtime.onStartup.addListener(() => { void discoverOpenTeamsTabs('startup'); });
chrome.runtime.onInstalled.addListener(() => { setTimeout(() => void discoverOpenTeamsTabs('post-install'), 1200); });
chrome.runtime.onStartup.addListener(() => { setTimeout(() => void discoverOpenTeamsTabs('post-startup'), 1200); });

// ---- config ----------------------------------------------------------------
async function getConfig() {
  const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get(['port', 'token']);
  return { port, token };
}

// ---- debug ring (service-worker side) --------------------------------------
// Kept in chrome.storage.session so it survives MV3 worker restarts.
const DEBUG_CAP = 250;
function dbg(m) {
  const line = `${new Date().toISOString().slice(11, 23)} ${m}`;
  chrome.storage.session.get({ dbgLog: [] }).then(({ dbgLog }) => {
    dbgLog.push(line);
    while (dbgLog.length > DEBUG_CAP) dbgLog.shift();
    chrome.storage.session.set({ dbgLog }).catch(() => {});
  }).catch(() => {});
}

// ---- notifications ----------------------------------------------------------
function notify(title, body) {
  try {
    chrome.notifications.create(
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/48.png'),
        title,
        message: body,
        priority: 2,
      },
      () => void chrome.runtime.lastError, // e.g. OS-level blocked; never throw
    );
  } catch (_) { /* non-browser env */ }
}
const THROTTLE = new Map();
function notifyThrottled(key, minMs, title, body) {
  const now = Date.now();
  const last = THROTTLE.get(key) || 0;
  if (now - last < minMs) return;
  THROTTLE.set(key, now);
  notify(title, body);
}

// ---- badge ------------------------------------------------------------------
async function setBadge(text, color = '#c5221f') {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* non-browser env */ }
}

// ---- trigger-server client --------------------------------------------------
let ownerPairing = null;
async function pairingIdentity(connection) {
  const bytes = new TextEncoder().encode(`${connection.port}:${connection.token}`);
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
let ownerConnection = null; // runtime-only credential snapshot; never persisted
async function validateOwnerPairing() {
  if (!ownerPairing) return true;
  const connection = ownerConnection || await getConfig();
  if (await pairingIdentity(connection) === ownerPairing) return true;
  forcedActive = false; stopSuppressed = true;
  await markStopIntent(); // old UUID retained; no renewal on changed pairing
  setBadge('ERR');
  return false;
}
async function callServer(path, body, connection = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const { port, token } = connection || await getConfig();
    const url = `http://127.0.0.1:${port}${path}`;
    const res = await fetch(url, {
      signal: controller.signal,
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: {}, error: String(e) };
  } finally { clearTimeout(timer); }
}

// ---- meeting-URL parsing (worker copy of content-script rules) ---------------
function parseMeetingUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'meet.google.com') {
      // pathname BEGINS WITH '/'; the pre-v1.3.3 pattern omitted the leading slash,
      // so this returned false for EVERY Meet URL — meetingUrl stayed false in all
      // field logs, no JOIN ever fired, and force-start (meetingish gate) was dead.
      return /^\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3,5}(\/|$)/i.test(u.pathname);
    }
    if (/(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft)$/i.test(u.hostname)) {
      return /(\/meeting[^\/]*|\/call|[#&?]conversation=)/i.test(u.href);
    }
    if (u.hostname.endsWith('zoom.us')) return /\/wc\/|\/j\//i.test(u.pathname);
  } catch (_) { /* not a URL */ }
  return false;
}

// ---- per-tab merged sensor state --------------------------------------------
// tabId -> { url, meetingUrl, platform, meetingName, frames: Map<frameId, sig>,
//            meetingSince, inMeeting, offSince, lastBeacon }
const tabSensors = new Map();
let forceEnabled = false;  // legacy preference retained; URL-only auto-join is unsafe
let orphanedStart = false;
let manualStartPending = 0; // Reserve manual ownership before any await.
let forcedActive = false;  // context-menu force: recording without any detection
let lastHbSent = 0;
let stopSuppressed = false;
let pendingStop = false;
let retryAfter = 0;
let serverAcknowledged = false;
let controlGeneration = 0;
let statusGeneration = 0; // start acknowledgements invalidate pre-start status snapshots only
let degraded = false;
let controlLoaded = false;
const sensorInvocations = new Map();
let sensorSequence=0;
const departureEpochs=new Map();
let unreadableStopIntent = false;
let controlTail = Promise.resolve();
let activeStartId = null;
let sessionId = null;
let stopTarget = null;
let stopIntentFlight = null; // share the durable-write barrier, including concurrent explicit stops
let stopFlight = null; // Cancellation transport bypasses the start queue; reconciliation does not.
function serializeControl(fn) {
  const result = controlTail.then(fn, fn);
  controlTail = result.catch(() => {});
  return result;
}
async function persistControl() {
  if (!controlLoaded) throw Error('durable control unreadable; refusing overwrite');
  await chrome.storage.session.set({ recordingControl: {
    forcedActive, stopSuppressed, pendingStop, retryAfter, serverAcknowledged, sessionId, stopTarget, activeStartId, ownerPairing,
  }});
}
function freshMeeting(t, now = Date.now()) {
  return t.inMeeting && now - (t.lastAffirmative || 0) <= FRAME_STALE_MS && !t.offSince;
}

function ownsAutomatic(t) { return t.inMeeting || t.restored; }
// Durable stop intent must precede deleting the final automatic owner.
async function relinquish(tabId, t, reason, remove = false) {
  const stop = ownsAutomatic(t) && !meetingAny(tabId) && !forcedActive && !manualStartPending;
  if (ownsAutomatic(t) && manualStartPending) orphanedStart = true;
  const cancelOwnedRequest = stop && (serverAcknowledged || activeStartId !== null);
  if (cancelOwnedRequest) await markStopIntent();
  t.inMeeting = false; t.restored = false; t.meetingSince = 0; t.offSince = 0;
  if (remove) tabSensors.delete(tabId);
  try { await persistTabs(); } catch (e) { dbg(`leave persistence failed: ${e}`); }
  if (cancelOwnedRequest) { const stopped = stopMeeting(reason); if (!activeStartId) await stopped; }
}
function markStopIntent() {
  if (!controlLoaded) { unreadableStopIntent = true; pendingStop = true; stopSuppressed = true; scheduleHeartbeat(); return Promise.resolve(false); }
  if (stopIntentFlight) return stopIntentFlight;
  controlGeneration++;
  if (!pendingStop) stopTarget = stopTarget || activeStartId || sessionId;
  pendingStop = true; retryAfter = Date.now() + 30000;
  scheduleHeartbeat();
  const intent = (async () => {
    try { await persistControl(); return true; }
    catch (e) { dbg(`stop intent persistence failed: ${e}`); setBadge('ERR'); return false; }
  })();
  stopIntentFlight = intent;
  intent.finally(() => { if (stopIntentFlight === intent) stopIntentFlight = null; });
  return intent;
}

function tabInfo(t) {
  return { platform: t.platform || 'unknown', meetingName: t.meetingName || 'Auto-recorded meeting' };
}
function meetingAny(exceptTabId = null) {
  return [...tabSensors.entries()].some(([id, t]) => id !== exceptTabId && ownsAutomatic(t));
}

async function persistTabs() {
  const flat = [...tabSensors.entries()].map(([id, t]) => [
    Number(id),
    {
      url: t.url, meetingUrl: t.meetingUrl, platform: t.platform, meetingName: t.meetingName,
      meetingSince: t.meetingSince, inMeeting: t.inMeeting, offSince: t.offSince,
      lastBeacon: t.lastBeacon, lastAffirmative: t.lastAffirmative, suppressed: t.suppressed, restored: t.restored, frames: undefined,
    },
  ]);
  await chrome.storage.session.set({ tabsState: flat });
}

async function restoreTabs() {
  const retainedStop=pendingStop, retainedTarget=stopTarget;
  const { tabsState = [], recordingControl = {} } = await chrome.storage.session.get({ tabsState: [], recordingControl: {} });
  controlLoaded = true;
  ownerPairing = recordingControl.ownerPairing || null;
  activeStartId = recordingControl.activeStartId || null;
  sessionId = recordingControl.sessionId || null;
  stopTarget = retainedTarget || recordingControl.stopTarget || null;
  pendingStop = !!recordingControl.pendingStop || unreadableStopIntent || retainedStop;
  if (unreadableStopIntent || retainedStop) { stopTarget = stopTarget || activeStartId || sessionId; stopSuppressed = true; }
  if (activeStartId && !pendingStop) { pendingStop = true; stopTarget = activeStartId; retryAfter = 0; }
  if (unreadableStopIntent || retainedStop) { await persistControl(); unreadableStopIntent = false; }
  forcedActive = !!recordingControl.forcedActive && !pendingStop;
  stopSuppressed = !!recordingControl.stopSuppressed || pendingStop;
  retryAfter = Number(recordingControl.retryAfter) || 0;
  serverAcknowledged = !!recordingControl.serverAcknowledged; // reconciled via ping before restoring REC
  const eligibleUrl = (url, platform) => {
    try { return platform === 'teams' ? TEAMS_HOST_RE.test(new URL(url).hostname) : parseMeetingUrl(url); } catch (_) { return false; }
  };
  const open = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
  if (!pendingStop && serverAcknowledged && !forcedActive && !tabsState.some(([id, v]) => open.has(Number(id)) && eligibleUrl(open.get(Number(id)).url, v.platform) && (v.inMeeting || v.restored))) await markStopIntent();
  for (const [id, v] of tabsState) {
    if (!open.has(Number(id))) continue;
    const url = open.get(Number(id)).url || '';
    tabSensors.set(Number(id), { ...v, url, meetingUrl: parseMeetingUrl(url), frames: new Map(), inMeeting: false,
      meetingSince: 0, offSince: 0, lastAffirmative: v.lastAffirmative || v.lastBeacon || 0,
      suppressed: !!v.suppressed || stopSuppressed, restored: eligibleUrl(url, v.platform) && !!(v.inMeeting || v.restored) });
  }
  await validateOwnerPairing();
  if (forcedActive || pendingStop || tabSensors.size) scheduleHeartbeat();
}

// Recompute one tab's merged state from its live frame signals. All join/leave
// decisions live here; content scripts only report raw per-frame observations.
async function recomputeTab(tabId, t) {
  const now = Date.now();
  // Drop frames that stopped beaming (closed iframe, navigated subframe, or a
  // background-throttled tab — beacons can slow to ~60s, hence the 70s threshold).
  for (const [fid, s] of [...t.frames.entries()]) {
    if (now - s.at > FRAME_STALE_MS) t.frames.delete(fid);
  }
  const sigs = [...t.frames.values()];
  if (!sigs.length && t.frameGoneAt) {
    if (now - t.frameGoneAt >= LEAVE_DEBOUNCE_MS) await relinquish(tabId,t,'Meeting frame disappeared');
    return;
  }
  if (!sigs.length) {
    // No live frames. If the tab is still on a meeting URL this is a hidden/
    // throttled tab (background beacons slow to ~60s) — keep meeting state and
    // let the alarm's GONE_SILENCE_MS check decide abandonment. Tearing down
    // here false-stopped recordings whenever the Meet tab was backgrounded.
    if (t.meetingUrl && t.inMeeting && now - (t.lastAffirmative || 0) <= GONE_SILENCE_MS) {
      await persistTabs();
      return;
    }
    if (t.restored && now - (t.lastAffirmative || 0) <= GONE_SILENCE_MS) return;
    await relinquish(tabId, t, 'Detection frames gone', true);
    return;
  }

  const anyJoined = sigs.some((s) => s.joined);
  const anyMediaNoLobby = sigs.some((s) => s.media && !s.lobby);
  // Teams keeps active calls inside its SPA root (field evidence: visible
  // "Leave" control at teams.cloud.microsoft/). This provider-specific signal
  // may join without a meeting URL. Google Meet and Zoom keep their URL gate.
  const teamsInCall = t.platform === 'teams' && anyJoined;


  // URL presence and idle beacons never count as affirmative joined evidence.
  const affirmative = t.platform === 'teams' ? teamsInCall : t.meetingUrl && (anyJoined || anyMediaNoLobby);
  if (affirmative) {
    t.lastAffirmative = Math.max(...sigs.filter(s => s.joined || (s.media && !s.lobby)).map(s => s.at));
    t.frameGoneAt = 0;
    t.offSince = 0; // suppression requires one uninterrupted dark interval
  }
  if (t.restored && affirmative) {
    // A failed reconciliation cannot convert unknown native ownership into a join.
    await persistTabs(); return;
  }
  if (t.restored && !affirmative) {
    if (!t.offSince) t.offSince = now;
    if (now - t.offSince >= LEAVE_DEBOUNCE_MS) await relinquish(tabId, t, 'Restored meeting evidence dark');
    await persistTabs();
    return;
  }
  if (t.inMeeting) {
    if (affirmative) { t.offSince = 0; }
    else if (!t.offSince) { t.offSince = now; }
    else if (now - t.offSince >= LEAVE_DEBOUNCE_MS) {
      await relinquish(tabId, t, `Left ${t.platform || 'meeting'}`);
    }
  } else if (!affirmative) {
    if (now - (t.lastDarkEvidence || 0) > LEAVE_DEBOUNCE_MS + 2000) t.offSince = 0;
    t.lastDarkEvidence = now;
    t.meetingSince = 0; t.joinLogged = false;
    // A full dark transition rearms this tab, not an arbitrary idle timer.
    if (t.suppressed) {
      if (!t.offSince) t.offSince = now;
      if (now - t.offSince >= LEAVE_DEBOUNCE_MS) { t.suppressed = false; t.offSince = 0; }
    }
  } else if (!t.suppressed && !pendingStop) {
    t.offSince = 0;
    if (!t.meetingSince || now - (t.lastJoinEvidence || 0) > JOIN_CONFIRM_MS + 2000) t.meetingSince = now;
    t.lastJoinEvidence = now;
    if (now - t.meetingSince >= JOIN_CONFIRM_MS) {
      t.inMeeting = true;
      stopSuppressed = false;
      scheduleHeartbeat(); // recovery exists even if initial persistence rejects
      try { await persistTabs(); await persistControl(); } catch (e) { dbg(`join persistence failed: ${e}`); }
      if ((!meetingAny(tabId) && !forcedActive) || serverAcknowledged) await startMeeting(tabInfo(t), tabId, t);
      scheduleHeartbeat(); // also retries failed starts; never fabricates REC
    }
  }

}

async function handleSensor(msg, sender) {
  const tabId=sender.tab?.id;if(tabId===null || tabId===undefined)return;
  const frameId=sender.frameId??0;
  const sensorKey=`${tabId}:${frameId}`, invocation={documentId:sender.documentId||null,sequence:++sensorSequence}, departure=departureEpochs.get(tabId)||0;
  // Unvalidated work must never supersede accepted current-document evidence.
  await bootReady;
  if(degraded || !(await validateOwnerPairing()))return;
  if((sensorInvocations.get(sensorKey)?.sequence||0)>invocation.sequence)return;
  if (sender.documentId && chrome.webNavigation?.getFrame) {
    try { const current = await chrome.webNavigation.getFrame({tabId, frameId}); if (!current || current.documentId !== sender.documentId) return; }
    catch (_) { return; } // unknown document must not replace current evidence
  }
  if(departure!==(departureEpochs.get(tabId)||0))return;
  const accepted=sensorInvocations.get(sensorKey);
  if(accepted && accepted.sequence>invocation.sequence)return;
  sensorInvocations.set(sensorKey,invocation);
  let t = tabSensors.get(tabId);
  if (!t) {
    t = { url: '', meetingUrl: false, platform: msg.platform, meetingName: '', frames: new Map(), meetingSince: 0, inMeeting: false, offSince: 0, lastBeacon: 0, suppressed: stopSuppressed };
    tabSensors.set(tabId, t);
  }
  const isTop = frameId === 0;
  const liveUrl = sender.tab?.url || msg.url;
  if (isTop || sender.tab?.url) {
    if (liveUrl && liveUrl !== t.url) {
      dbg(`[tab ${tabId}] top-frame url :: ${liveUrl.slice(0, 100)}`);
      t.url = liveUrl;
      t.meetingUrl = parseMeetingUrl(liveUrl);
      t.frames.clear(); t.meetingSince = 0;
      t.joinLogged = false;
      t.meetingSince = t.meetingUrl ? t.meetingSince : 0;
    }
    if (isTop) {
      t.platform = msg.platform || t.platform;
      t.meetingName = msg.meetingName || t.meetingName;
    }
  }
  const previous = t.frames.get(frameId);
  if (sender.documentId && previous?.documentId && previous.documentId !== sender.documentId) {
    t.meetingSince=0; t.lastJoinEvidence=0; t.joinLogged=false;
    if(isTop)t.frames.clear();
  }
  t.frames.set(frameId, {
    documentId: sender.documentId || null, joined: !!msg.joined, media: !!msg.media, lobby: !!msg.lobby, pathOk: !!msg.pathOk, at: Date.now(),
  });
  t.lastBeacon = Date.now();
  if (t.restored) {
    const affirmative = t.platform === 'teams' ? !!msg.joined : t.meetingUrl && (!!msg.joined || (!!msg.media && !msg.lobby));
    if (affirmative && !t.suppressed && !pendingStop) {
      const generation = controlGeneration;
      const status = statusGeneration;
      const ping = await callServer('/ping', undefined, ownerConnection);
      if (generation !== controlGeneration || status !== statusGeneration || pendingStop || tabSensors.get(tabId) !== t || t.frames.get(frameId)?.documentId!==sender.documentId && sender.documentId) return;
      if (ping.ok && ping.json?.recording === true && ping.json?.extension_owned === true && !!sessionId && ping.json?.request_id === sessionId && !ping.json?.stop_requested && !ping.json?.stopping) {
        t.restored = false; t.inMeeting = true; serverAcknowledged = true;
        await persistControl();
      } else if (ping.ok && ping.json?.recording === false && !serverAcknowledged && !ping.json?.stop_requested && !ping.json?.stopping) {
        t.restored = false; t.inMeeting = false; t.meetingSince = 0;
      } else if (ping.ok && (ping.json?.recording === true || serverAcknowledged || ping.json?.stop_requested || ping.json?.stopping)) {
        controlGeneration++; stopSuppressed = true; serverAcknowledged = false; forcedActive = false;
        for (const tracked of tabSensors.values()) { tracked.restored = false; tracked.suppressed = true; tracked.inMeeting = false; tracked.meetingSince = 0; tracked.offSince = 0; }
        await persistTabs();
        controlGeneration++;
        await persistControl();
      }
    }
  }
  await recomputeTab(tabId, t);
  try { await persistTabs(); } catch (e) { dbg(`evidence persistence failed: ${e}`); }
}

async function tokenReady() {
  const { token } = await getConfig();
  return Boolean(token);
}

async function startMeeting(info, tabId = null, owner = null) {
  const generation = controlGeneration;
  return serializeControl(() => startMeetingNow(info, tabId, owner, generation));
}
async function startMeetingNow(info, tabId, owner, generation) {
  const valid = () => !degraded && generation === controlGeneration && !pendingStop && !stopSuppressed &&
    (tabId === null || (tabSensors.get(tabId) === owner && freshMeeting(owner)));
  if (!valid()) return { ok: false, error: 'stop-intent' };
  if (serverAcknowledged) {
    const ping = await callServer('/ping', undefined, ownerConnection);
    if (!valid()) return { ok: false, error: 'stale-start' };
    if (ping.ok && ping.json?.recording && ping.json?.extension_owned === true && !!sessionId && ping.json?.request_id === sessionId && !ping.json?.stop_requested && !ping.json?.stopping)
      return { ok: true, json: { ok: true, recording: true } };
    if (!ping.ok) return { ok: false, error: 'ownership-check-unavailable' };
    if (tabId !== null) {
      // An acknowledged desktop stop/disappearance is never automatic restart permission.
      controlGeneration++;
      serverAcknowledged = false; forcedActive = false; stopSuppressed = true;
      if(!pendingStop){sessionId=null;ownerPairing=null;ownerConnection=null;}
      for (const t of tabSensors.values()) { t.suppressed = true; t.inMeeting = false; t.restored = false; t.meetingSince = 0; }
      await persistTabs(); await persistControl();
      setBadge(ping.json?.stopping ? 'STOP' : '');
      return { ok: false, error: 'desktop-stop-suppressed' };
    }
    serverAcknowledged = false; forcedActive = false;
  }
  retryAfter = Date.now() + 30000;
  await persistControl();
  dbg(`startMeeting: platform=${info.platform} name="${info.meetingName}"`);
  if (!(await tokenReady())) {
    setBadge('!');
    dbg('startMeeting: no token configured');
    notify('Pund-IT Meeting Assistant Auto-Record not paired', 'Open the extension options and paste the token from Pund-IT Meeting Assistant → Settings → Preferences → Auto-record.');
    return { ok: false, error: 'no-token' };
  }
  if (!valid()) return { ok: false, error: 'stale-start' };
  const connection = await getConfig();
  const capability = await callServer('/ping?capability=1', undefined, connection);
  if (!capability.ok || capability.json?.ownership_protocol !== 2) { setBadge('ERR'); notifyThrottled('protocol',60000,'Compatible desktop required','Update and pair the desktop before automatic recording.'); return {ok:false,error:capability.ok?'compatible-desktop-required':'desktop-unreachable'}; }
  if (!valid() || await pairingIdentity(await getConfig()) !== await pairingIdentity(connection)) return {ok:false,error:'pairing-changed'};
  ownerPairing = await pairingIdentity(connection);
  ownerConnection = connection;
  const requestId = crypto.randomUUID();
  activeStartId = requestId;
  await persistControl(); // durable identity BEFORE transport can reach native
  if (!valid()) { activeStartId = null; await persistControl(); return { ok: false, error: "stale-start" }; }
  const res = await callServer('/trigger', {
    request_id: requestId,
    action: 'start',
    platform: info.platform,
    meeting_name: info.meetingName,
  }, connection);
  dbg(`server start response: ok=${res.ok} status=${res.status} json=${JSON.stringify(res.json)}`);
  const succeeded = res.ok && res.json?.ok && res.json?.recording === true && res.json?.request_id === requestId;
  const transferable = generation === controlGeneration && !pendingStop && !stopSuppressed && !degraded &&
    [...tabSensors.values()].some(t => freshMeeting(t));
  if (!valid() && !(succeeded && transferable)) {
    if (res.status === 0 || succeeded || (res.json?.retry_stop && res.json?.request_id === requestId)) {
      orphanedStart = true;
      if (!pendingStop) stopTarget = res.json?.request_id || requestId;
      // Transport loss is uncertain even with a retained owner. Never adopt it.
      if (res.status === 0 || res.json?.retry_stop || (succeeded && !manualStartPending && !forcedActive) || (!manualStartPending && !forcedActive && !meetingAny())) {
        await markStopIntent();
        void stopMeeting('Uncertain or ownerless late start');
      }
    }
    if (activeStartId === requestId) activeStartId = null;
    return { ok: false, error: 'stale-start' };
  }
  if (succeeded) {
    sessionId = requestId;
    serverAcknowledged = true;
    statusGeneration++; // invalidate status snapshots taken before this start
    const startedGeneration = controlGeneration;
    scheduleHeartbeat();
    try { await persistControl(); } catch (e) { dbg(`start persistence failed: ${e}`); }
    if (startedGeneration !== controlGeneration || pendingStop || stopSuppressed) return { ok: false, error: 'stale-start' };
    setBadge('REC', '#188038');
    scheduleHeartbeat();
    notify('Recording started', `${info.meetingName} — ${info.platform}`);
  } else if (res.status === 0) {
    // A timed-out start may still be initializing: stop intent must reach native.
    await markStopIntent();
    void stopMeeting('Uncertain start result');
    setBadge('off');
    dbg('server unreachable (fetch failed) — Pund-IT Meeting Assistant app probably not running');
    notifyThrottled('server-down', 5 * 60_000, 'Pund-IT Meeting Assistant not reachable', `Could not reach 127.0.0.1:${await getConfig().then(({ port }) => port)}/trigger — launch Pund-IT Meeting Assistant. Recording NOT started (${info.meetingName}).`);
  } else if (res.status === 401 || res.json?.error?.includes('unauthorized')) {
    setBadge('ERR', '#c5221f');
    dbg('server rejected token (401) — extension token does not match the app');
    notifyThrottled('token-401', 5 * 60_000, 'Pund-IT Meeting Assistant rejected the token', 'The paired token is wrong or was regenerated. Copy it again from Pund-IT Meeting Assistant → Settings → Preferences → Auto-record → paste into extension options.');
  } else if (res.json?.error?.includes('failed to bind')) {
    setBadge('off');
    dbg('server reports bind failure');
    notifyThrottled('bind-fail', 5 * 60_000, 'Pund-IT Meeting Assistant trigger server down', 'Pund-IT Meeting Assistant is running but its trigger port is busy. Restart the app to retry.');
  } else if (res.json?.retry_stop && res.json?.request_id === requestId) {
    activeStartId = requestId;
    await markStopIntent();
    void stopMeeting('Failed startup cleanup retry');
    setBadge('ERR');
  } else if (res.json?.error) {
    setBadge('ERR', '#c5221f');
    dbg(`server start failed: ${res.json.error}`);
    notify('Auto-record failed to start', String(res.json.error).slice(0, 160));
  }
  if (activeStartId === requestId) activeStartId = null;
  if(!activeStartId && !sessionId && !serverAcknowledged && !pendingStop){ownerPairing=null;ownerConnection=null;}
  try { await persistControl(); } catch (e) { dbg(`request completion persistence failed: ${e}`); }
  return res;
}

async function stopMeeting(reason = '') {
  // Reserve the flight synchronously, before persistence yields, so duplicates
  // share both the cancellation request and its serialized result reconciliation.
  if (stopFlight) return stopFlight;
  const intent = markStopIntent();
  const response = (async()=>{
    if (!(await intent)) return {ok:false,error:'stop-intent-not-durable'};
    const connection=ownerConnection || await getConfig();
    if(ownerPairing && await pairingIdentity(connection)!==ownerPairing)return {ok:false,error:'original-pairing-required'};
    const capability=await callServer('/ping?capability=1',undefined,connection);
    if(!capability.ok || capability.json?.ownership_protocol!==2)return {ok:false,error:'compatible-desktop-required'};
    return callServer('/trigger',{action:'stop',platform:'unknown',request_id:stopTarget},connection);
  })();
  const flight = serializeControl(async () => {
    await intent;
    const res = await response;
    if (res.ok && res.json?.ok && res.json?.recording !== true) {
      pendingStop = false; serverAcknowledged = false; orphanedStart = false; sessionId = null; stopTarget = null; activeStartId = null; ownerPairing = null; ownerConnection = null;
      try { await persistControl(); } catch (e) { dbg(`stop result persistence failed: ${e}`); }
      setBadge('');
      if (!degraded && !meetingAny() && !forcedActive) stopHeartbeat();
      notify('Recording stop request completed', reason);
    } else {
      retryAfter = Date.now() + 30000;
      try { await persistControl(); } catch (e) { dbg(`stop retry persistence failed: ${e}`); }
      setBadge('ERR');
    }
    return res;
  });
  stopFlight = flight;
  try { return await flight; } finally { if (stopFlight === flight) stopFlight = null; }
}

// ---- force start (audio-free, DOM-free trigger) ------------------------------
// Right-click the extension icon → "Force start recording now", or the options
// page button. Records until force-stop / browser close; deliberately dumb.
async function forceStart() {
  await bootReady;
  if (pendingStop || degraded) return { ok: false, error: 'stop-pending' };
  manualStartPending++;
  try {
  stopSuppressed = false;
  try { await persistControl(); } catch (e) { dbg(`manual intent persistence failed: ${e}`); }
  const liveTab = [...tabSensors.values()].find((t) => t.meetingUrl);
  const info = {
    platform: liveTab?.platform || 'manual',
    meetingName: liveTab?.meetingName || 'Forced recording (manual)',
  };
  dbg(`FORCE START (${info.platform} / "${info.meetingName}")`);
  const res = await startMeeting(info);
  if (res.error === 'ownership-check-unavailable') return res;
  forcedActive = !!(res.ok && res.json?.ok && res.json?.recording === true && serverAcknowledged && sessionId && !stopSuppressed && !pendingStop);
  try { await persistControl(); } catch (e) { dbg(`manual result persistence failed: ${e}`); }
  if (forcedActive && !pendingStop && !stopSuppressed) setBadge('REC', '#188038');
  return res;
  } finally {
    manualStartPending--;
    if (!manualStartPending && !forcedActive && !meetingAny() && (serverAcknowledged || orphanedStart)) {
      await stopMeeting('Manual ownership handoff failed');
    }
    if (forcedActive) orphanedStart = false;
  }
}
async function forceStop() {
  await bootReady;
  dbg('FORCE STOP');
  const intent = markStopIntent();
  const stopped = stopMeeting('Manual stop (forced)');
  forcedActive = false; stopSuppressed = true;
  await intent;
  for (const t of tabSensors.values()) { t.suppressed = true; t.inMeeting = false; t.restored = false; t.meetingSince = 0; t.offSince = 0; }
  try { await persistTabs(); await persistControl(); } catch (e) { dbg(`stop ownership persistence failed: ${e}`); }
  return stopped;
}

// ---- meetily ping (options page / badge status) -----------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'GET_STATUS') {
    (async () => {
      const { token } = await getConfig();
      if (!token) return sendResponse({ configured: false, server: null });
      const ping = await callServer('/ping', undefined, ownerConnection);
      sendResponse({ configured: true, server: ping.ok ? 'up' : 'down', recording: ping.json?.recording ?? null });
    })();
    return true; // async sendResponse
  }
  if (msg.kind === 'GET_TAB_STATE') {
    const t = tabSensors.get(sender.tab?.id);
    sendResponse({ tabInMeeting: t?.inMeeting ?? false });
  }
  if (msg.kind === 'CONFIGURED') {
    setBadge('');
  }
  if (msg.kind === 'FORCE_START') {
    forceStart()
      .then(sendResponse)
      .catch((e) => {
        dbg(`FORCE_START error: ${e && e.stack ? e.stack : e}`);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }
  if (msg.kind === 'FORCE_STOP') {
    forceStop()
      .then(sendResponse)
      .catch((e) => {
        dbg(`FORCE_STOP error: ${e && e.stack ? e.stack : e}`);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }
  return false;
});

// ---- debug / census views (options page) — FRAME-ROUTED ----------------------
// all_frames content scripts mean several frames answer per tab; only one response
// wins without frame routing (a UI-less subframe used to mask the meeting frame's
// truth). Collect from every frame via webNavigation.getAllFrames.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.kind === 'GET_DEBUG_VIEW') {
    (async () => {
      const { port, token, debugMode = false } = await chrome.storage.local.get(['port', 'token', 'debugMode']);
      let ping = null;
      if (token) {
        const p = await callServer('/ping');
        ping = { ok: p.ok, status: p.status, recording: p.json?.recording ?? null, error: p.error ?? null };
      }
      sendResponse({
        config: { port, tokenSet: Boolean(token), debugMode, forceEnabled },
        ping,
        tabs: [...tabSensors.entries()].map(([id, t]) => ({
          id,
          url: t.url,
          meetingUrl: t.meetingUrl,
          inMeeting: t.inMeeting,
          platform: t.platform,
          meetingName: t.meetingName,
          frames: [...t.frames.entries()].map(([fid, s]) => ({ frameId: fid, ...s })),
        })),
        forced: forcedActive,
        workerLog: (await chrome.storage.session.get({ dbgLog: [] })).dbgLog,
      });
    })();
    return true;
  }
  if (msg.kind === 'COLLECT_TAB_DEBUG') {
    (async () => {
      const matches = chrome.runtime.getManifest().content_scripts.flatMap((cs) => cs.matches);
      let query = [];
      try { query = await chrome.tabs.query({ url: matches }); } catch (_) {}
      // Always include supported Teams tabs explicitly, even when a stale Chrome
      // content-script registration failed to inject after an extension update.
      let teamsTabs = [];
      try { teamsTabs = await chrome.tabs.query({ url: ['https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*', 'https://m365.cloud.microsoft/*'] }); } catch (_) {}
      const byId = new Map([...query, ...teamsTabs].map((tab) => [tab.id, tab]));
      query = [...byId.values()];
      const found = [];
      await Promise.all(
        query.map(async (t) => {
          let frames = [];
          try { frames = await chrome.webNavigation.getAllFrames({ tabId: t.id }) || []; } catch (_) {}
          // Top frame first so its URL/state lead the log; then subframes.
          frames.sort((a, b) => a.frameId - b.frameId);
          await Promise.all(
            frames.map(
              (f) =>
                new Promise((resolve) => {
                  try {
                    chrome.tabs.sendMessage(t.id, { kind: 'GET_TAB_DEBUG' }, { frameId: f.frameId }, (resp) => {
                      void chrome.runtime.lastError;
                      if (resp) found.push({ tabId: t.id, frameId: f.frameId, url: resp.url, title: resp.title, platform: resp.platform, signals: resp.signals, census: resp.census, log: resp.log || [] });
                      resolve();
                    });
                  } catch (_) { resolve(); }
                }),
            ),
          );
        }),
      );
      sendResponse(found);
    })();
    return true;
  }
  if (msg.kind === 'GET_FORCE_ENABLED') {
    sendResponse({ forceEnabled, forced: forcedActive });
    return true;
  }
  return false;
});

// Content-script events: SENSOR beacons, DEBUG_TICK, MSG_NOTIFY.
// .catch on the async path: an unhandled rejection in MV3 is INVISIBLE (worker
// console only) — v1.3.0-1.3.2 died silently here on the missing tokenReady fn.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.kind === 'SENSOR') {
    handleSensor(msg, sender).catch((e) => dbg(`SENSOR handler error: ${e && e.stack ? e.stack : e}`));
    return;
  }
  if (msg.kind === 'FRAME_GONE') {
    const tabId=sender.tab?.id, frameId=sender.frameId??0, key=`${tabId}:${frameId}`;
    const signal=tabSensors.get(tabId)?.frames.get(frameId), pending=sensorInvocations.get(key);
    if ((signal?.documentId && signal.documentId!==sender.documentId) || (!signal && pending?.documentId && pending.documentId!==sender.documentId)) return;
    departureEpochs.set(tabId,(departureEpochs.get(tabId)||0)+1);
    if(!pending?.documentId || pending.documentId===sender.documentId)sensorInvocations.delete(key); // unique object tokens prevent old work becoming current again
    const departed=tabSensors.get(tabId);
    if(departed)departed.frames.delete(frameId);
    void bootReady.then(async()=>{
      const t=tabSensors.get(tabId);if(!t)return;
      if(t.frames.get(frameId)?.documentId && t.frames.get(frameId).documentId!==sender.documentId)return;
      t.frames.delete(frameId);
      if(![...t.frames.values()].some(s=>s.joined||(s.media&&!s.lobby))){t.frameGoneAt=Date.now();t.offSince=t.frameGoneAt;}
      await recomputeTab(tabId,t);
    }).catch(e=>dbg(`frame removal failed: ${e}`));
    return;
  }
  if (msg.kind === 'DEBUG_TICK') {
    const tabId = sender.tab?.id;
    const url = typeof msg.url === 'string' ? msg.url : '';
    dbg(`[tab ${tabId}${sender.frameId ? ` f${sender.frameId}` : ''}] ${msg.label}${url ? ` :: ${url.slice(0, 120)}` : ''}`);
    return;
  }
  if (msg.kind === 'MSG_NOTIFY') {
    notify(msg.title || 'Pund-IT Meeting Assistant Auto-Record', msg.body || '');
    return;
  }
});

// ---- tab lifecycle ----------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  departureEpochs.set(tabId,(departureEpochs.get(tabId)||0)+1);
  for(const key of sensorInvocations.keys())if(key.startsWith(`${tabId}:`))sensorInvocations.delete(key);
  await bootReady;
  const t = tabSensors.get(tabId);
  if (t) await relinquish(tabId, t, 'Tab closed', true);
});

// Tab navigated: if the top URL left the meeting domain, sensors die naturally
// (no more beacons) — but handle the common case immediately.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if(changeInfo.url)departureEpochs.set(tabId,(departureEpochs.get(tabId)||0)+1);
  if(changeInfo.url)for(const key of sensorInvocations.keys())if(key.startsWith(`${tabId}:`))sensorInvocations.delete(key);
  await bootReady;
  const url = changeInfo.url || tab?.url;
  const t = tabSensors.get(tabId);
  if (t && url && url !== t.url) {
    // SPA same-domain navigation is authoritative too; never retain old frame evidence.
    t.url = url; t.meetingUrl = parseMeetingUrl(url); t.frames.clear(); t.meetingSince = 0;
    let host = ''; try { host = new URL(url).hostname; } catch (_) {}
    if (!DOMAIN_RE.test(host) || (t.platform !== 'teams' && !t.meetingUrl)) {
      await relinquish(tabId, t, 'Left meeting URL', true);
    } else await persistTabs();
  }
});

if(chrome.webNavigation?.onCommitted)chrome.webNavigation.onCommitted.addListener(details=>{
 const tabId=details.tabId,frameId=details.frameId??0;
 departureEpochs.set(tabId,(departureEpochs.get(tabId)||0)+1);
 sensorInvocations.delete(`${tabId}:${frameId}`);
 const t=tabSensors.get(tabId);if(!t)return;
 if(frameId===0)t.frames.clear();else t.frames.delete(frameId);
 t.meetingSince=0;t.lastJoinEvidence=0;t.joinLogged=false;
});

// ---- heartbeat alarm (keeps worker alive + flows through) --------------------
function scheduleHeartbeat() {
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 0.25 });
}
function stopHeartbeat() {
  chrome.alarms.clear(ALARM_HEARTBEAT);
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_HEARTBEAT) return;
  await bootReady;
  if (degraded) {
    try { await restoreTabs(); degraded = false; }
    catch (e) { setBadge('ERR'); return; }
  }
  const now = Date.now();
  if (pendingStop) {
    if (now >= retryAfter) await stopMeeting('Retrying pending stop');
    return; // no heartbeat or start while stop is pending
  }
  for (const [id, t] of [...tabSensors]) {
    if (ownsAutomatic(t) && now - (t.lastAffirmative || 0) > GONE_SILENCE_MS) {
      await relinquish(id, t, 'Affirmative meeting evidence expired');
    }
  }
  if (pendingStop) return;
  for(const [id,t] of [...tabSensors])if(ownsAutomatic(t) && t.offSince && now-t.offSince>=LEAVE_DEBOUNCE_MS)await relinquish(id,t,'Observed dark leave confirmed');
  for (const [id,t] of tabSensors) if(t.frameGoneAt && now-t.frameGoneAt>=LEAVE_DEBOUNCE_MS) await relinquish(id,t,'Meeting frame disappearance confirmed');
  if(pendingStop)return;
  const retainedOwner = () => serverAcknowledged && [...tabSensors.values()].some(t=>ownsAutomatic(t) && !t.offSince && Date.now()-(t.lastAffirmative||0)<=GONE_SILENCE_MS);
  const activeTab = [...tabSensors.values()].find(t => freshMeeting(t, now));
  if (!activeTab && !forcedActive && !retainedOwner()) { setBadge(''); if (!meetingAny()) stopHeartbeat(); return; }
  if (!(await validateOwnerPairing())) return;
  const generation = controlGeneration;
  const status = statusGeneration;
  const ping = await callServer('/ping', undefined, ownerConnection);
  if (generation !== controlGeneration || status !== statusGeneration || pendingStop || (!forcedActive && !retainedOwner() && ![...tabSensors.values()].some(t => freshMeeting(t)))) return;
  if (!ping.ok) { setBadge('off'); return; }
  if (ping.json?.stop_requested || ping.json?.stopping) {
    controlGeneration++;
    forcedActive = false; stopSuppressed = true; serverAcknowledged = false;
    if(!pendingStop){sessionId=null;ownerPairing=null;ownerConnection=null;}
    for (const t of tabSensors.values()) { t.suppressed = true; t.inMeeting = false; t.meetingSince = 0; }
    const stoppedGeneration = controlGeneration;
    try { await persistTabs(); await persistControl(); } catch (e) { dbg(`stop status persistence failed: ${e}`); }
    if (stoppedGeneration !== controlGeneration || status !== statusGeneration) return;
    setBadge(ping.json?.stopping ? 'STOP' : '');
    return;
  }
  if (ping.json?.recording === true) {
    if (ping.json?.extension_owned !== true || !sessionId || ping.json?.request_id !== sessionId) {
      controlGeneration++;
      const suppressedGeneration = controlGeneration;
      serverAcknowledged = false; forcedActive = false; stopSuppressed = true;
      if(!pendingStop){sessionId=null;ownerPairing=null;ownerConnection=null;}
      for (const t of tabSensors.values()) { t.suppressed = true; t.inMeeting = false; t.restored = false; t.meetingSince = 0; }
      try { await persistTabs(); await persistControl(); } catch (e) { dbg(`owner reconciliation persistence failed: ${e}`); }
      if (suppressedGeneration !== controlGeneration || status !== statusGeneration || pendingStop) return;
      setBadge(''); return;
    }
    if (!serverAcknowledged) return; // global native recording is not extension ownership
    try { await persistControl(); } catch (e) { dbg(`heartbeat persistence failed: ${e}`); }
    if (generation !== controlGeneration || status !== statusGeneration || pendingStop || stopSuppressed || (!forcedActive && !retainedOwner() && ![...tabSensors.values()].some(t => freshMeeting(t)))) return;
    setBadge('REC', '#188038');
    if (generation !== controlGeneration || status !== statusGeneration || pendingStop || stopSuppressed) return;
    await callServer('/heartbeat?request_id=' + encodeURIComponent(sessionId),undefined,ownerConnection);
  } else if (ping.json?.recording === false) {
    // A previously acknowledged recording disappearing is intentional/unknown,
    // not permission to resurrect. Only a failed, never-acknowledged start retries.
    if (serverAcknowledged || forcedActive) {
      controlGeneration++;
    forcedActive = false; stopSuppressed = true; serverAcknowledged = false;
    if(!pendingStop){sessionId=null;ownerPairing=null;ownerConnection=null;}
      for (const t of tabSensors.values()) { t.suppressed = true; t.inMeeting = false; t.meetingSince = 0; }
      const stoppedGeneration = controlGeneration;
      try { await persistTabs(); await persistControl(); } catch (e) { dbg(`disappearance persistence failed: ${e}`); }
      if (stoppedGeneration !== controlGeneration || status !== statusGeneration) return;
      setBadge('');
    } else if (activeTab && !stopSuppressed && now >= retryAfter) {
      await startMeeting(tabInfo(activeTab), [...tabSensors].find(([, t]) => t === activeTab)?.[0], activeTab);
    }
  }
});

// ---- action context menu (force start/stop) ----------------------------------
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'meetily-force-start', title: 'Force start recording now', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'meetily-force-stop', title: 'Stop forced recording', contexts: ['action'] });
    });
  } catch (_) { /* contextMenus unavailable */ }
});
chrome.contextMenus.onClicked.addListener((info, _tab) => {
  if (info.menuItemId === 'meetily-force-start') void forceStart();
  if (info.menuItemId === 'meetily-force-stop') void forceStop();
});

// ---- boot --------------------------------------------------------------------
const bootReady = (async () => {
  try {
  const { forceEnabled: fe } = await chrome.storage.local.get({ forceEnabled: false });
  forceEnabled = !!fe;
  let bootCount = 0;
  try {
    ({ bootCount = 0 } = await chrome.storage.session.get({ bootCount: 0 }));
    await chrome.storage.session.set({ bootCount: bootCount + 1 });
  } catch (e) { dbg(`boot diagnostics unavailable: ${e}`); }
  dbg(bootCount === 0 ? 'worker v1.4.0 booted (fresh session)' : `worker v1.4.0 cold-restarted (boot #${bootCount + 1}) — restoring tab state`);
  await restoreTabs();
  } catch (e) {
    // Unknown storage/tab inventory must never create or renew ownership. Keep
    // the worker callable in fail-closed mode and retry the native stop.
    stopTarget = stopTarget || activeStartId || sessionId;
    degraded = true; stopSuppressed = true; pendingStop = true; controlGeneration++;
    scheduleHeartbeat(); setBadge('ERR'); dbg(`degraded boot: ${e}`);
    if (controlLoaded) {
      try { await persistControl(); } catch (_) {}
      try { await stopMeeting('Degraded worker boot'); } catch (_) {}
    }
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.token)) {
    controlGeneration++;
    // Do not serialize credential values into session storage. Runtime ownership
    // retains the original transport; after restart pairing changes need explicit
    // operator cleanup on the old desktop (documented limitation).
    void bootReady.then(async()=>{if(sessionId || activeStartId){forcedActive=false;stopSuppressed=true;for(const t of tabSensors.values()){t.suppressed=true;t.inMeeting=false;t.restored=false;t.meetingSince=0;t.offSince=0;}await markStopIntent();void stopMeeting('Pairing configuration changed');await persistTabs();}}).catch(e=>dbg(`pairing cleanup failed: ${e}`));
  }
  if (area === 'local' && changes.forceEnabled) {
    forceEnabled = !!changes.forceEnabled.newValue;
    dbg(`forceEnabled -> ${forceEnabled}`);
    // Recompute every tab NOW: meetingUrl is only refreshed by top-frame beacons,
    // which background-throttled tabs send rarely — waiting for one made the
    // force toggle appear to do nothing (v1.3.1 field finding).
    void bootReady.then(async () => { for (const [tabId, t] of tabSensors.entries()) await recomputeTab(tabId, t); });
  }
});

// ---- install-time default config --------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const { token } = await getConfig();
  if (!token) {
    await chrome.storage.local.set({ token: crypto.randomUUID().replace(/-/g, '') });
    dbg('onInstalled: seeded placeholder token (paste the app token to pair)');
  }
});