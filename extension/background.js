// Meetily Auto-Record — MV3 service worker.
// Owns meeting state across tabs, talks to the local Meetily trigger server, alarms keep-alive.
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
async function callServer(path, body) {
  const { port, token } = await getConfig();
  const url = `http://127.0.0.1:${port}${path}`;
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: {}, error: String(e) };
  }
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
let forceEnabled = false;  // options toggle: meeting-URL alone counts as in-call
let forcedActive = false;  // context-menu force: recording without any detection
let lastHbSent = 0;

function tabInfo(t) {
  return { platform: t.platform || 'unknown', meetingName: t.meetingName || 'Auto-recorded meeting' };
}
function meetingAny(exceptTabId = null) {
  return [...tabSensors.entries()].some(([id, t]) => id !== exceptTabId && t.inMeeting);
}

async function persistTabs() {
  const flat = [...tabSensors.entries()].map(([id, t]) => [
    Number(id),
    {
      url: t.url, meetingUrl: t.meetingUrl, platform: t.platform, meetingName: t.meetingName,
      meetingSince: t.meetingSince, inMeeting: t.inMeeting, offSince: t.offSince,
      lastBeacon: t.lastBeacon, frames: undefined,
    },
  ]);
  chrome.storage.session.set({ tabsState: flat }).catch(() => {});
}

async function restoreTabs() {
  try {
    const { tabsState = [] } = await chrome.storage.session.get({ tabsState: [] });
    for (const [id, v] of tabsState) {
      const t = { ...v, frames: new Map() };
      tabSensors.set(Number(id), t);
    }
    if (tabSensors.size > 0) {
      dbg(`restored ${tabSensors.size} tracked tab(s) after worker restart`);
      if (meetingAny()) {
        setBadge('REC', '#188038');
        scheduleHeartbeat();
      }
    }
  } catch (_) { /* fresh worker */ }
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
  if (!sigs.length) {
    // No live frames. If the tab is still on a meeting URL this is a hidden/
    // throttled tab (background beacons slow to ~60s) — keep meeting state and
    // let the alarm's GONE_SILENCE_MS check decide abandonment. Tearing down
    // here false-stopped recordings whenever the Meet tab was backgrounded.
    if (t.meetingUrl) {
      await persistTabs();
      return;
    }
    if (t.inMeeting) {
      dbg(`[tab ${tabId}] all detection frames gone -> LEAVE`);
      t.inMeeting = false;
      await persistTabs();
      if (!meetingAny() && !forcedActive) await stopMeeting('Detection frames gone');
    }
    tabSensors.delete(tabId);
    await persistTabs();
    return;
  }

  const anyJoined = sigs.some((s) => s.joined);
  const anyMediaNoLobby = sigs.some((s) => s.media && !s.lobby);
  // Teams keeps active calls inside its SPA root (field evidence: visible
  // "Leave" control at teams.cloud.microsoft/). This provider-specific signal
  // may join without a meeting URL. Google Meet and Zoom keep their URL gate.
  const teamsInCall = t.platform === 'teams' && anyJoined;
  const meetingish = (t.meetingUrl && (anyJoined || anyMediaNoLobby || forceEnabled)) || teamsInCall;

  if (t.inMeeting) {
    // Server heartbeat flows from the 15s alarm (recompute runs every 2s per
    // beacon — calling the server from here would spam it 30x more often).
  } else if (meetingish) {
    if (!t.meetingSince) t.meetingSince = now;
    if (now - t.meetingSince > JOIN_CONFIRM_MS) {
      t.inMeeting = true;
      dbg(`[tab ${tabId}] JOIN confirmed (url=${t.meetingUrl} leaveBtn=${anyJoined} mediaNoLobby=${anyMediaNoLobby}${forceEnabled ? ' +forceBypass' : ''})`);
      await persistTabs();
      notify('Meeting detected', `${tabInfo(t).meetingName} on ${t.platform || 'meeting'} — starting auto-record.`);
      if (!meetingAny(tabId)) await startMeeting(tabInfo(t));
      setBadge('REC', '#188038');
      scheduleHeartbeat();
    } else {
      if (!t.joinLogged) { dbg(`[tab ${tabId}] meeting-ish signal seen, confirming in ${JOIN_CONFIRM_MS}ms`); t.joinLogged = true; }
    }
  } else {
    t.meetingSince = 0;
    t.joinLogged = false;
    if (t.inMeeting) {
      if (!t.offSince) {
        t.offSince = now;
        dbg(`[tab ${tabId}] detection went dark, ${LEAVE_DEBOUNCE_MS / 1000}s leave debounce started`);
      } else if (now - t.offSince > LEAVE_DEBOUNCE_MS) {
        t.inMeeting = false;
        t.offSince = 0;
        dbg(`[tab ${tabId}] LEAVE after ${LEAVE_DEBOUNCE_MS / 1000}s dark`);
        await persistTabs();
        if (!meetingAny() && !forcedActive) await stopMeeting('Left meeting');
      }
    }
  }
}

async function handleSensor(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const frameId = sender.frameId ?? 0;
  let t = tabSensors.get(tabId);
  if (!t) {
    t = { url: '', meetingUrl: false, platform: msg.platform, meetingName: '', frames: new Map(), meetingSince: 0, inMeeting: false, offSince: 0, lastBeacon: 0 };
    tabSensors.set(tabId, t);
  }
  const isTop = !!msg.isTop;
  if (isTop) {
    if (msg.url && msg.url !== t.url) {
      dbg(`[tab ${tabId}] top-frame url :: ${msg.url.slice(0, 100)}`);
      t.url = msg.url;
      t.meetingUrl = parseMeetingUrl(msg.url);
      t.joinLogged = false;
      t.meetingSince = t.meetingUrl ? t.meetingSince : 0;
    }
    t.platform = msg.platform || t.platform;
    t.meetingName = msg.meetingName || t.meetingName;
  }
  t.frames.set(frameId, {
    joined: !!msg.joined, media: !!msg.media, lobby: !!msg.lobby, pathOk: !!msg.pathOk, at: Date.now(),
  });
  t.lastBeacon = Date.now();
  await recomputeTab(tabId, t);
}

async function tokenReady() {
  const { token } = await getConfig();
  return Boolean(token);
}

async function startMeeting(info) {
  dbg(`startMeeting: platform=${info.platform} name="${info.meetingName}"`);
  if (!(await tokenReady())) {
    setBadge('!');
    dbg('startMeeting: no token configured');
    notify('Meetily Auto-Record not paired', 'Open the extension options and paste the token from Meetily → Settings → Preferences → Auto-record.');
    return { ok: false, error: 'no-token' };
  }
  const res = await callServer('/trigger', {
    action: 'start',
    platform: info.platform,
    meeting_name: info.meetingName,
  });
  dbg(`server start response: ok=${res.ok} status=${res.status} json=${JSON.stringify(res.json)}`);
  if (res.ok && res.json?.ok) {
    setBadge('REC', '#188038');
    scheduleHeartbeat();
    notify('Recording started', `${info.meetingName} — ${info.platform}`);
  } else if (res.status === 0) {
    setBadge('off');
    dbg('server unreachable (fetch failed) — Meetily app probably not running');
    notifyThrottled('server-down', 5 * 60_000, 'Meetily not reachable', `Could not reach 127.0.0.1:${await getConfig().then(({ port }) => port)}/trigger — launch Meetily. Recording NOT started (${info.meetingName}).`);
  } else if (res.status === 401 || res.json?.error?.includes('unauthorized')) {
    setBadge('ERR', '#c5221f');
    dbg('server rejected token (401) — extension token does not match the app');
    notifyThrottled('token-401', 5 * 60_000, 'Meetily rejected the token', 'The paired token is wrong or was regenerated. Copy it again from Meetily → Settings → Preferences → Auto-record → paste into extension options.');
  } else if (res.json?.error?.includes('failed to bind')) {
    setBadge('off');
    dbg('server reports bind failure');
    notifyThrottled('bind-fail', 5 * 60_000, 'Meetily trigger server down', 'Meetily is running but its trigger port is busy. Restart the app to retry.');
  } else if (res.json?.error) {
    setBadge('ERR', '#c5221f');
    dbg(`server start failed: ${res.json.error}`);
    notify('Auto-record failed to start', String(res.json.error).slice(0, 160));
  }
  return res;
}

async function stopMeeting(reason = '') {
  dbg(`stopMeeting ${reason}`);
  const res = await callServer('/trigger', { action: 'stop', platform: 'unknown' });
  dbg(`server stop response: ok=${res.ok} status=${res.status}`);
  if (res.ok) {
    setBadge('');
    stopHeartbeat();
    notify('Recording stopped & saved', reason);
  } else {
    setBadge('ERR');
    dbg(`stop failed: status=${res.status}`);
    notifyThrottled('stop-fail', 60_000, 'Auto-record stop failed', 'Could not stop the recording — check Meetily.');
  }
  return res;
}

// ---- force start (audio-free, DOM-free trigger) ------------------------------
// Right-click the extension icon → "Force start recording now", or the options
// page button. Records until force-stop / browser close; deliberately dumb.
async function forceStart() {
  const liveTab = [...tabSensors.values()].find((t) => t.meetingUrl);
  const info = {
    platform: liveTab?.platform || 'manual',
    meetingName: liveTab?.meetingName || 'Forced recording (manual)',
  };
  dbg(`FORCE START (${info.platform} / "${info.meetingName}")`);
  forcedActive = true;
  const res = await startMeeting(info);
  if (res.ok) setBadge('REC', '#188038');
  return res;
}
async function forceStop() {
  dbg('FORCE STOP');
  forcedActive = false;
  await stopMeeting('Manual stop (forced)');
}

// ---- meetily ping (options page / badge status) -----------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'GET_STATUS') {
    (async () => {
      const { token } = await getConfig();
      if (!token) return sendResponse({ configured: false, server: null });
      const ping = await callServer('/ping');
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
  if (msg.kind === 'DEBUG_TICK') {
    const tabId = sender.tab?.id;
    const url = typeof msg.url === 'string' ? msg.url : '';
    dbg(`[tab ${tabId}${sender.frameId ? ` f${sender.frameId}` : ''}] ${msg.label}${url ? ` :: ${url.slice(0, 120)}` : ''}`);
    return;
  }
  if (msg.kind === 'MSG_NOTIFY') {
    notify(msg.title || 'Meetily Auto-Record', msg.body || '');
    return;
  }
});

// ---- tab lifecycle ----------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const t = tabSensors.get(tabId);
  const had = t?.inMeeting ?? false;
  if (had) dbg(`[tab ${tabId}] closed during meeting -> LEAVE`);
  tabSensors.delete(tabId);
  await persistTabs();
  if (had && !meetingAny() && !forcedActive) await stopMeeting('Tab closed');
});

// Tab navigated: if the top URL left the meeting domain, sensors die naturally
// (no more beacons) — but handle the common case immediately.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab?.url) {
    const t = tabSensors.get(tabId);
    const stillMeeting = /^https:\/\/[^\s]*\.?(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft|zoom\.us)/i.test(tab.url);
    if (t && !stillMeeting) {
      const had = t.inMeeting;
      dbg(`[tab ${tabId}] navigated away from meeting URL -> dropping sensor state`);
      tabSensors.delete(tabId);
      await persistTabs();
      if (had && !meetingAny() && !forcedActive) void stopMeeting('Left meeting URL');
    }
  }
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
  const active = meetingAny() || forcedActive;
  if (!active) {
    stopHeartbeat();
    setBadge('');
    return;
  }
  // Silence watchdog: an in-meeting tab whose frames beamed nothing for
  // GONE_SILENCE_MS is gone (browser suspended the tab, or it was closed
  // without an event) — stop the recording rather than beat forever.
  const now = Date.now();
  for (const [tabId, t] of [...tabSensors.entries()]) {
    if (t.inMeeting && now - (t.lastBeacon || 0) > GONE_SILENCE_MS) {
      dbg(`[tab ${tabId}] no sensor beacon for ${Math.round(GONE_SILENCE_MS / 1000)}s -> LEAVE (silent)`);
      tabSensors.delete(tabId);
      await persistTabs();
      if (!meetingAny() && !forcedActive) await stopMeeting('Meeting detection went silent');
    }
  }
  if (meetingAny() || forcedActive) {
    const res = await callServer('/heartbeat');
    if (!res.ok) dbg(`alarm heartbeat failed: status=${res.status}`);
  }
  // Resurrect: if any tab sits in a live meeting but the app reports NOT recording
  // (engine self-stop, error budget, crash) — restart the recording. Field log 6:
  // recording silently went false 16s in; nothing told the worker.
  if (meetingAny() && !(await chrome.storage.session.get({ resurrectArmed: false })).resurrectArmed) {
    await chrome.storage.session.set({ resurrectArmed: true });
    try {
      const ping = await callServer('/ping');
      // Only resurrect when the server is up, answering, and NOT recording.
      if (ping.ok && ping.json?.recording === false) {
        const t = [...tabSensors.entries()].find(([, v]) => v.inMeeting);
        if (t) {
          dbg(`[tab ${t[0]}] in-meeting but app reports recording=false -> RESURRECT`);
          await startMeeting(tabInfo(t[1]));
        }
      }
    } catch (e) {
      dbg(`resurrect check failed: ${e}`);
    } finally {
      setTimeout(() => chrome.storage.session.set({ resurrectArmed: false }).catch(() => {}), 30000);
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
(async () => {
  const { forceEnabled: fe } = await chrome.storage.local.get({ forceEnabled: false });
  forceEnabled = !!fe;
  const { bootCount = 0 } = await chrome.storage.session.get({ bootCount: 0 });
  await chrome.storage.session.set({ bootCount: bootCount + 1 });
  dbg(bootCount === 0 ? 'worker v1.3 booted (fresh session)' : `worker v1.3 cold-restarted (boot #${bootCount + 1}) — restoring tab state`);
  await restoreTabs();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.forceEnabled) {
    forceEnabled = !!changes.forceEnabled.newValue;
    dbg(`forceEnabled -> ${forceEnabled}`);
    // Recompute every tab NOW: meetingUrl is only refreshed by top-frame beacons,
    // which background-throttled tabs send rarely — waiting for one made the
    // force toggle appear to do nothing (v1.3.1 field finding).
    for (const [tabId, t] of tabSensors.entries()) void recomputeTab(tabId, t);
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