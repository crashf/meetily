// Meetily Auto-Record — MV3 service worker.
// Owns meeting state across tabs, talks to the local Meetily trigger server, alarms keep-alive.
const DEFAULT_PORT = 7788;
const HEARTBEAT_MS = 15000;
const ALARM_HEARTBEAT = 'meetily-hb';
const ALARM_RETRY = 'meetily-retry';

// ---- config ----------------------------------------------------------------
async function getConfig() {
  const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get(['port', 'token']);
  return { port, token };
}

async function setBadge(text, color = '#c5221f') {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* non-browser env */ }
}

// ---- trigger-server client -------------------------------------------------
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

// __PART2__

// ---- state machine ---------------------------------------------------------
// tabId -> { inMeeting, platform, meetingName }. Worker decides global meeting
// state: any tab in-meeting => meeting active; last tab leaves => stop.
const tabs = new Map();

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
  if (!(await tokenReady())) {
    setBadge('!'); // not configured
    return { ok: false, error: 'no-token' };
  }
  const res = await callServer('/trigger', {
    action: 'start',
    platform: info.platform,
    meeting_name: info.meetingName,
  });
  if (res.ok && res.json?.ok) {
    setBadge('REC', '#188038');
    scheduleHeartbeat();
  } else if (res.status === 0 || res.json?.error?.includes('failed to bind')) {
    if (res.status === 0) setBadge('off'); // Meetily not running
  } else if (res.json?.error?.includes('unauthorized')) {
    setBadge('!'); // wrong token
  }
  return res;
}

async function stopMeeting() {
  const res = await callServer('/trigger', { action: 'stop', platform: 'unknown' });
  if (res.ok) {
    setBadge('');
    stopHeartbeat();
  } else {
    setBadge('ERR');
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

// Content-script events: JOIN / LEAVE / HEARTBEAT
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!['JOIN', 'LEAVE', 'HEARTBEAT'].includes(msg.kind)) return;
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  void handleContentEvent(tabId, msg);
});

async function handleContentEvent(tabId, msg) {
  const prev = tabs.get(tabId) || { inMeeting: false, platform: msg.platform, meetingName: '' };
  if (msg.kind === 'JOIN') {
    tabs.set(tabId, {
      inMeeting: true,
      platform: msg.platform || 'unknown',
      meetingName: msg.meeting_name || 'Auto-recorded meeting',
    });
    // Start only when no OTHER tab was already in a meeting (recording is global).
    if (otherMeetingCount(tabId) === 0) await startMeeting(tabs.get(tabId));
  } else if (msg.kind === 'HEARTBEAT') {
    const cur = tabs.get(tabId);
    if (cur) {
      cur.lastBeat = Date.now();
      tabs.set(tabId, cur);
      void callServer('/heartbeat');
    }
  } else if (msg.kind === 'LEAVE') {
    const had = tabs.get(tabId)?.inMeeting ?? false;
    tabs.set(tabId, { ...prev, inMeeting: false });
    if (had && !meetingState().any) await stopMeeting();
  }
}

function otherMeetingCount(exceptTabId) {
  return [...tabs.entries()].filter(([id, v]) => id !== exceptTabId && v.inMeeting).length;
}

// Tabs closing while in a meeting => LEAVE
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const had = tabs.get(tabId)?.inMeeting ?? false;
  tabs.delete(tabId);
  if (had && !meetingState().any) await stopMeeting();
});

// Tab navigated away from meeting URL: content script re-evaluates via tick();
// also cover onUpdated URL changes for SPA navigations.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab?.url) {
    const had = tabs.get(tabId)?.inMeeting ?? false;
    const stillMeeting = /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|[a-z0-9.-]*zoom\.us)/i.test(tab.url);
    if (had && !stillMeeting) {
      tabs.set(tabId, { inMeeting: false, platform: 'unknown', meetingName: '' });
      if (!meetingState().any) void stopMeeting();
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
      await callServer('/heartbeat');
    } else {
      stopHeartbeat();
      setBadge('');
    }
  }
});

// ---- install-time default config -------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const { token } = await getConfig();
  if (!token) {
    await chrome.storage.local.set({ token: crypto.randomUUID().replace(/-/g, '') });
  }
});

// (end of service worker)