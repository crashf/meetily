// Meetily Auto-Record — MV3 service worker.
// Owns meeting state across tabs, talks to the local Meetily trigger server, alarms keep-alive.
// v1.1 (PUN-801): notifications on detect/start/stop/error, persistent debug ring,
// session-persisted tab state (MV3 cold starts), wider Teams-domain matching.
const DEFAULT_PORT = 7788;
const HEARTBEAT_MS = 15000;
const ALARM_HEARTBEAT = 'meetily-hb';
const DOMAIN_RE =
  /(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft|([a-z0-9-]+\.)*zoom\.us)$/i;

// ---- config ----------------------------------------------------------------
async function getConfig() {
  const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get(['port', 'token']);
  return { port, token };
}

// ---- debug ring (service-worker side) --------------------------------------
// Kept in chrome.storage.session so it survives MV3 worker restarts.
// Entries come from the worker itself (state machine, transport) and from
// content scripts (DEBUG_TICK). Viewed via the options page (GET_DEBUG_VIEW).
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

// ---- state machine ---------------------------------------------------------
// tabId -> { inMeeting, platform, meetingName, lastBeat }. Worker decides global meeting
// state: any tab in-meeting => meeting active; last tab leaves => stop.
// NOTE: persisted to storage.session — MV3 workers cold-start mid-meeting and would
// otherwise forget the meeting (heartbeats stop, the app's 5-min deadman kills the
// recording even though the meeting is live).
const tabs = new Map();

function persistTabs() {
  chrome.storage.session.set({ tabsState: [...tabs.entries()] }).catch(() => {});
}
async function restoreTabs() {
  try {
    const { tabsState = [] } = await chrome.storage.session.get({ tabsState: [] });
    for (const [id, v] of tabsState) tabs.set(Number(id), v);
    if (tabs.size > 0) {
      dbg(`restored ${tabs.size} tracked tab(s) after worker restart`);
      const any = meetingState().any;
      if (any) {
        setBadge('REC', '#188038');
        scheduleHeartbeat();
      }
    }
  } catch (_) { /* fresh worker */ }
}

function meetingState() {
  const inMeeting = [...tabs.entries()].filter(([, v]) => v.inMeeting);
  if (inMeeting.length === 0) return { any: false };
  const [tabId, info] = inMeeting[0];
  return { any: true, tabId, info };
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
    sendResponse({ tabInMeeting: tabs.get(sender.tab?.id)?.inMeeting ?? false });
  }
  if (msg.kind === 'CONFIGURED') {
    setBadge('');
  }
});

// ---- debug views (options page) ---------------------------------------------
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
        config: { port, tokenSet: Boolean(token), debugMode },
        ping,
        tabs: [...tabs.entries()].map(([id, v]) => ({ id, ...v })),
        workerLog: (await chrome.storage.session.get({ dbgLog: [] })).dbgLog,
      });
    })();
    return true;
  }
  if (msg.kind === 'COLLECT_TAB_DEBUG') {
    (async () => {
      const matches = chrome.runtime.getManifest().content_scripts.flatMap((cs) => cs.matches);
      const found = [];
      let query = [];
      try { query = await chrome.tabs.query({ url: matches }); } catch (_) {}
      await Promise.all(
        query.map(
          (t) =>
            new Promise((resolve) => {
              try {
                chrome.tabs.sendMessage(t.id, { kind: 'GET_TAB_DEBUG' }, (resp) => {
                  void chrome.runtime.lastError;
                  if (resp) found.push({ tabId: t.id, url: resp.url, state: resp.state, log: resp.log || [] });
                  resolve();
                });
              } catch (_) {
                resolve();
              }
            }),
        ),
      );
      sendResponse(found);
    })();
    return true;
  }
  return false;
});

// Content-script events: JOIN / LEAVE / HEARTBEAT / DEBUG_TICK / MSG_NOTIFY
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (['JOIN', 'LEAVE', 'HEARTBEAT', 'DEBUG_TICK', 'MSG_NOTIFY'].includes(msg.kind)) {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    void handleContentEvent(tabId, msg);
  }
});

async function handleContentEvent(tabId, msg) {
  if (msg.kind === 'DEBUG_TICK') {
    const url = typeof msg.url === 'string' ? msg.url : '';
    dbg(`[tab ${tabId}] ${msg.label}${url ? ` :: ${url.slice(0, 120)}` : ''}`);
    return;
  }
  if (msg.kind === 'MSG_NOTIFY') {
    // Detection notifications originate here so failed creates never touch content.
    notify(msg.title || 'Meetily Auto-Record', msg.body || '');
    return;
  }
  const prev = tabs.get(tabId) || { inMeeting: false, platform: msg.platform, meetingName: '' };
  if (msg.kind === 'JOIN') {
    dbg(`[tab ${tabId}] JOIN (platform=${msg.platform})`);
    tabs.set(tabId, {
      inMeeting: true,
      platform: msg.platform || 'unknown',
      meetingName: msg.meeting_name || 'Auto-recorded meeting',
      lastBeat: Date.now(),
    });
    persistTabs();
    // Start only when no OTHER tab was already in a meeting (recording is global).
    if (otherMeetingCount(tabId) === 0) await startMeeting(tabs.get(tabId));
  } else if (msg.kind === 'HEARTBEAT') {
    const cur = tabs.get(tabId);
    if (cur) {
      cur.lastBeat = Date.now();
      tabs.set(tabId, cur);
      persistTabs();
      const res = await callServer('/heartbeat');
      if (!res.ok) {
        dbg(`heartbeat failed: status=${res.status}`);
        if (res.status === 0) {
          notifyThrottled('server-down', 5 * 60_000, 'Meetily not reachable', 'Auto-record lost contact with the Meetily app — is it still running? If it exited, this recording stops being managed.');
        } else if (res.status === 401) {
          notifyThrottled('token-401', 5 * 60_000, 'Meetily rejected the token', 'Re-paste the token from Meetily settings into the extension options.');
        }
      }
    }
  } else if (msg.kind === 'LEAVE') {
    const had = tabs.get(tabId)?.inMeeting ?? false;
    dbg(`[tab ${tabId}] LEAVE (was in meeting: ${had})`);
    tabs.set(tabId, { ...prev, inMeeting: false });
    persistTabs();
    if (had && !meetingState().any) await stopMeeting();
  }
}

function otherMeetingCount(exceptTabId) {
  return [...tabs.entries()].filter(([id, v]) => id !== exceptTabId && v.inMeeting).length;
}

// Tabs closing while in a meeting => LEAVE
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const had = tabs.get(tabId)?.inMeeting ?? false;
  if (had) dbg(`[tab ${tabId}] closed during meeting -> LEAVE`);
  tabs.delete(tabId);
  persistTabs();
  if (had && !meetingState().any) await stopMeeting('Tab closed');
});

// Tab navigated away from meeting URL: content script re-evaluates via tick();
// also cover onUpdated URL changes for SPA navigations. NOTE: domain list must
// match the manifest + content script or a LEAVE never fires on new domains.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab?.url) {
    const had = tabs.get(tabId)?.inMeeting ?? false;
    const stillMeeting = /^https:\/\/[^\s]*\.?(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft|zoom\.us)/i.test(tab.url);
    if (had && !stillMeeting) {
      dbg(`[tab ${tabId}] navigated away from meeting URL -> LEAVE`);
      tabs.set(tabId, { inMeeting: false, platform: 'unknown', meetingName: '' });
      persistTabs();
      if (!meetingState().any) void stopMeeting('Left meeting URL');
    }
  }
});

// ---- heartbeat alarm (keeps worker alive + flows through even when idle) ----
function scheduleHeartbeat() {
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 0.25 });
}
function stopHeartbeat() {
  chrome.alarms.clear(ALARM_HEARTBEAT);
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) {
    const ms = meetingState().any;
    if (ms) {
      const res = await callServer('/heartbeat');
      if (!res.ok) dbg(`alarm heartbeat failed: status=${res.status}`);
    } else {
      stopHeartbeat();
      setBadge('');
    }
  }
});

// ---- boot -------------------------------------------------------------------
(async () => {
  const { bootCount = 0 } = await chrome.storage.session.get({ bootCount: 0 });
  await chrome.storage.session.set({ bootCount: bootCount + 1 });
  dbg(bootCount === 0 ? 'worker booted (fresh session)' : `worker cold-restarted (boot #${bootCount + 1}) — restoring tab state`);
  await restoreTabs();
})();

// ---- install-time default config -------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const { token } = await getConfig();
  if (!token) {
    await chrome.storage.local.set({ token: crypto.randomUUID().replace(/-/g, '') });
    dbg('onInstalled: seeded placeholder token (paste the app token to pair)');
  }
});

// (end of service worker)