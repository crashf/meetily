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
  // Probe telemetry: what the DOM actually contains when we can't see a leave button.
  const probeState = { lightMatches: 0, visibleMatches: 0, shadowRoots: 0, shadowMatches: 0, sampleLabel: '', lastDeepAt: 0 };

  // Visibility that works for fixed/sticky controls and shadow trees: offsetParent
  // is null for position:fixed elements (Meet's control bar!) even when fully visible,
  // which made v1.0/v1.1 reject the live leave button. FIX (PUN-801 field log 2:
  // leaveVisible=false for an entire real meeting). Rects + computed style instead.
  function isReallyVisible(n) {
    try {
      if (!(n instanceof Element)) return false;
      const rects = n.getClientRects();
      if (!rects.length) return false;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(n);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  // Deep query across open AND closed shadow roots. chrome.dom.openOrClosedShadowRoot
  // is available to extension content scripts; el.shadowRoot covers open roots.
  // Expensive (host walk) — time-gated to once per 15s by the caller.
  function deepQueryAll(selector, maxHosts = 300) {
    const results = [];
    const seenRoots = new Set();
    const queue = [document];
    let shadowRoots = 0;
    const hostIsOpen = !!window.chrome?.dom?.openOrClosedShadowRoot;
    while (queue.length && shadowRoots < maxHosts) {
      const root = queue.shift();
      try { results.push(...root.querySelectorAll(selector)); } catch (_) {}
      let hosts = [];
      try { hosts = root.querySelectorAll('*'); } catch (_) {}
      for (const el of hosts) {
        let sr = null;
        try { sr = el.shadowRoot; } catch (_) {}
        if (!sr && hostIsOpen) {
          try { sr = window.chrome.dom.openOrClosedShadowRoot(el); } catch (_) {}
        }
        if (sr && !seenRoots.has(sr)) {
          seenRoots.add(sr);
          shadowRoots++;
          queue.push(sr);
        }
      }
    }
    probeState.shadowRoots = shadowRoots;
    return results;
  }

  function leaveButtonVisible() {
    let lightMatches = 0;
    let visible = 0;
    let shadowMatches = 0;
    let sampleLabel = '';
    for (const sel of LEAVE_SELECTORS) {
      try {
        let nodes = document.querySelectorAll(sel);
        lightMatches += nodes.length;
        if (nodes.length === 0 && Date.now() - probeState.lastDeepAt > 15000) {
          probeState.lastDeepAt = Date.now();
          nodes = deepQueryAll(sel); // shadow pierce, throttled
          shadowMatches += nodes.length;
        }
        for (const n of nodes) {
          if (isReallyVisible(n)) {
            if (!sampleLabel) {
              sampleLabel = n.getAttribute('aria-label') || n.getAttribute('data-tooltip') || n.id || sel.slice(0, 40);
            }
            selectorHits[sel] = (selectorHits[sel] || 0) + 1;
            probeState.visibleMatches = 1;
            probeState.sampleLabel = sampleLabel;
            return true;
          }
        }
      } catch (_) { /* invalid selector on older chromium */ }
    }
    // Record probe stats when nothing found (throttled reporter logs these).
    probeState.lightMatches = lightMatches;
    probeState.visibleMatches = visible;
    probeState.shadowMatches = shadowMatches;
    if (!sampleLabel) probeState.sampleLabel = sampleLabel;
    return false;
  }

  // Live video signal (redundancy net for leave-button selector rot): Google Meet's
  // in-call UI always renders <video> elements with actual dimensions. Green room
  // may too (camera preview) — that's why this never acts alone: lobby detection
  // below suppresses it, and the 3s join-confirm applies regardless.
  function mediaPlaying() {
    for (const v of document.querySelectorAll('video')) {
      if ((v.videoWidth || 0) > 0 && (v.videoHeight || 0) > 0 && isReallyVisible(v)) return true;
    }
    return false;
  }

  // Meet green-room suppressor: visible "Join now"/"Ask to join" = still a lobby,
  // even if pathOk/video already true. Prevents recording the green room.
  function lobbyVisible() {
    for (const sel of [
      'button[data-jsname="join-button"], div[role="button"][data-jsname="join-button"]',
      'button[aria-label*="Join now" i], div[role="button"][aria-label*="Join now" i]',
      'button[aria-label*="Ask to join" i], div[role="button"][aria-label*="Ask to join" i]',
      'button[data-mdc-dialog-button]', // generic Meet dialog confirm
    ]) {
      try {
        for (const n of document.querySelectorAll(sel)) {
          if (isReallyVisible(n)) return true;
        }
      } catch (_) {}
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
    const joined = leaveButtonVisible();
    const pathOk = inMeetingPath();
    const media = mediaPlaying();
    const lobby = lobbyVisible();
    const inCallSignal = joined || (media && !lobby);
    dbg(`state=${state} leaveVisible=${joined} pathOk=${pathOk} media=${media} lobby=${lobby} (probe: light=${probeState.lightMatches} vis=${probeState.visibleMatches} shadow=${probeState.shadowRoots}r/${probeState.shadowMatches}m "${probeState.sampleLabel}")`);

    if (state === 'IDLE') {
      if (pathOk && inCallSignal) {
        if (joinSeenAt === 0) {
          joinSeenAt = Date.now();
          state = 'JOINING';
          dbg(`JOINING: ${joined ? 'leave button' : 'live media (no lobby)'} + meeting URL seen, confirming ~3s`);
          sendDebugTick('joining', { url: location.href, pathOk, joined, media, lobby, title: document.title });
        }
      } else {
        joinSeenAt = 0;
        if (pathOk && !inCallSignal) dbg('IDLE: meeting URL but no in-call signal yet (lobby?)');
      }
    } else if (state === 'JOINING') {
      if (inCallSignal && pathOk) {
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
      if (inCallSignal && pathOk) {
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
  dbg(`content script v1.1.2 loaded on ${location.hostname} (platform=${platform()})`);
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