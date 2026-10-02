// Meetily Auto-Record — content script.
// Detects "in a live meeting" on Meet/Teams/Zoom web and reports JOIN/LEAVE/HEARTBEAT
// to the service worker, which talks to the local Meetily trigger server.
// v1.1 (PUN-801): on-detection notification, persistent debug ring, wider Teams
// selectors, stop-path domain fix. Debug tap (window.__meetilyLog/__meetilyTick) kept.
(() => {
  // ---- debug mode ------------------------------------------------------------
  let DEBUG = false;
  const dbgLog = [];
  function dbg(m) {
    const line = `${new Date().toISOString().slice(11, 23)} ${m}`;
    dbgLog.push(line);
    if (dbgLog.length > 400) dbgLog.shift();
    window.__meetilyLog = dbgLog; // DevTools tap kept for bug reports
    if (DEBUG) console.debug('[Meetily]', line);
  }
  chrome.storage.local.get({ debugMode: false }, (v) => { DEBUG = !!v.debugMode; });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.debugMode) DEBUG = !!changes.debugMode.newValue;
  });
  function sendDebugTick(label, extra) {
    // Always record; the worker rings decide retention (ring is trimmed there too).
    try { chrome.runtime.sendMessage({ kind: 'DEBUG_TICK', label, ...extra }); } catch (_) {}
  }

  // ---- platform detection ----------------------------------------------------
  const MEETING_DOMAINS =
    /(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft|([a-z0-9-]+\.)*zoom\.us)$/i;

  const LEAVE_SELECTORS = [
    // Google Meet: the exit button carries data-call-exit-id (kept even when
    // aria-label wording changes); plus visible-aria / tooltip candidates.
    'button[data-call-exit-id]',
    'button[data-call-exit-id][aria-label*="eave"]',
    'button[data-tooltip*="Leave"]',
    'div[role="button"][aria-label*="eave"], div[role="button"][aria-label*="Leave"]',
    // Teams web (Leave / Hang up) — scoped to the in-meeting bar to avoid false
    // positives from "Leave" text elsewhere in the app shell (prejoin, calendar).
    'span[aria-label="Meeting compose bar"] button[aria-label*="eave"], span[aria-label="Meeting compose bar"] div[role="button"][aria-label*="eave"]',
    'button[aria-label*="ang up"], button[aria-label*="ang op"], button[id*="phone-hangup"]',
    // Legacy Teams selectors kept as secondary candidates
    'button[title*="eave"]',
    // Zoom web client
    'button.leave-btn, .footer-button__wrapper button[aria-label*="eave"], button[aria-label*="End"]',
    'div[role="button"][aria-label*="eave"]',
  ];

  const isGoogleMeet = () => location.hostname === 'meet.google.com';
  const isTeams = () =>
    /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft)$/i.test(location.hostname);
  const isZoom = () => location.hostname.endsWith('zoom.us');
  const platform = () => (isGoogleMeet() ? 'google_meet' : isTeams() ? 'teams' : isZoom() ? 'zoom' : 'unknown');

  // URL stage detection: a real meeting URL (post/pre-join) vs homepage.
  // FIX (PUN-801): Teams path check now covers the same domains as the manifest,
  // including teams.cloud.microsoft/m365.cloud.microsoft — the old regex only knew
  // teams.microsoft.com/teams.live.com, so a JOIN there could never be UN-seen:
  // LEAVE never fired, and new joins on those domains were mis-detected too.
  function inMeetingPath() {
    // FIX (PUN-801 field log 2026-10-02): Meet codes are 3-4-3 (e.g. khk-gyzd-jgq);
    // the old regex demanded a 5-letter last segment so EVERY standard Meet code
    // failed pathOk and detection silently never fired. Accept 3-4-3 .. 3-4-5,
    // tolerate digits in any segment.
    if (isGoogleMeet()) return /^\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3,5}(\/|$)/i.test(location.pathname);
    if (isTeams()) return /(\/meeting[^\/]*|\/call|[#&?]conversation=)/i.test(location.href);
    if (isZoom()) return /\/wc\/|\/j\//i.test(location.pathname);
    return false;
  }

  // Meeting title extraction (best effort).
  function meetingTitle() {
    let t = document.title || '';
    t = t.replace(/\s*\|\s*(Google Meet|Microsoft Teams|Zoom)\s*$/i, '').trim();
    if (isGoogleMeet() && /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3,5}$/i.test(t)) {
      return t.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/([A-Z])/g, ' $1').trim();
    }
    if (isTeams()) {
      const parts = t.split(/\s*\|\s*/);
      const meetingish = parts.find((p) => /meeting|call/i.test(p)) || parts[parts.length - 1];
      return meetingish.trim();
    }
    return t || platform();
  }

  let selectorHits = {}; // selector -> count this session (debug visibility)
  function leaveButtonVisible() {
    for (const sel of LEAVE_SELECTORS) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const n of nodes) {
          const r = n.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && n.offsetParent !== null) {
            selectorHits[sel] = (selectorHits[sel] || 0) + 1;
            return true;
          }
        }
      } catch (_) { /* invalid selector on older chromium */ }
    }
    return false;
  }

  let state = 'IDLE'; // IDLE | JOINING | IN_MEETING
  let joinSeenAt = 0;

  function send(kind, extra) {
    chrome.runtime.sendMessage({ kind, platform: platform(), tabId: 'cs', ...extra }).catch(() => {});
  }

  // On-detection notification fires from the worker (MSG_NOTIFY); content only reports.
  function notifyDetected() {
    try { chrome.runtime.sendMessage({ kind: 'MSG_NOTIFY', title: 'Meeting detected', body: `${meetingTitle() || platform()} on ${platform()} — starting auto-record.` }); } catch (_) {}
  }

  function tick() {
    dbg(`state=${state} leaveVisible=${leaveButtonVisible()} pathOk=${inMeetingPath()}`);
    const joined = leaveButtonVisible();
    const pathOk = inMeetingPath();

    if (state === 'IDLE') {
      if (pathOk && joined) {
        if (joinSeenAt === 0) {
          joinSeenAt = Date.now();
          state = 'JOINING';
          dbg('JOINING: leave button + meeting URL seen, confirming ~3s');
          sendDebugTick('joining', { url: location.href, pathOk, joined, title: document.title });
        }
      } else {
        joinSeenAt = 0;
        if (pathOk && !joined) dbg('IDLE: meeting URL but no leave button visible yet (lobby?)');
      }
    } else if (state === 'JOINING') {
      if (joined && pathOk) {
        if (Date.now() - joinSeenAt > 3000) {
          state = 'IN_MEETING';
          send('JOIN', { meeting_name: meetingTitle() });
          notifyDetected();
          dbg('IN_MEETING: JOIN sent');
          sendDebugTick('join-confirmed', { url: location.href, title: document.title });
        }
      } else if (Date.now() - joinSeenAt > 30000) {
        state = 'IDLE';
        joinSeenAt = 0;
        dbg('JOINING timed out (30s) — back to IDLE');
      }
    } else if (state === 'IN_MEETING') {
      if (joined && pathOk) {
        send('HEARTBEAT');
        tick.absentSince = 0;
      } else {
        // Require 2 consecutive absent ticks to debounce UI hiccups.
        if (tick.absentSince === 0) {
          tick.absentSince = Date.now();
          dbg('IN_MEETING: detection went dark, starting 8s leave debounce');
        } else if (Date.now() - tick.absentSince > 8000) {
          state = 'IDLE';
          tick.absentSince = 0;
          dbg('LEAVE after 8s without detection');
          sendDebugTick('leave', { url: location.href });
          send('LEAVE');
        }
      }
    }
  }
  tick.absentSince = 0;
  window.__meetilyTick = tick;
  dbg(`content script v1.1 loaded on ${location.hostname} (platform=${platform()})`);
  sendDebugTick('script-loaded', { url: location.href, title: document.title });

  // DevTools helpers for bug reports:
  //   __meetilyTick()                     — run one detection pass now
  //   __meetilyLog                        — ring buffer
  //   __meetilySelectorHits()             — which selectors have matched so far
  window.__meetilySelectorHits = () => ({ ...selectorHits });

  // Observe DOM + URL changes; poll as fallback every 2s (cheap: selector scan only).
  setInterval(tick, 2000);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      dbg(`href changed -> ${location.href}`);
      tick();
    }
  }, 1000);
  new MutationObserver(() => tick()).observe(document.body, { childList: true, subtree: true });

  // Answer the worker's log collectors.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.kind === 'GET_TAB_DEBUG') {
      sendResponse({ url: location.href, title: document.title, platform: platform(), log: dbgLog, state });
      return true;
    }
    if (msg.kind === 'RECHECK_STATE') {
      sendResponse({ url: location.href, title: document.title, platform: platform(), state });
      return true;
    }
    return false;
  });

  // Tell the worker this tab closed (worker also watches chrome.tabs, belt & braces).
  window.addEventListener('beforeunload', () => {
    if (state === 'IN_MEETING') send('LEAVE', { closing: true });
  });

  console.log('[Meetily Auto-Record] content script v1.1 active on', location.hostname);
})();