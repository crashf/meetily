// Pund-IT Meeting Assistant Auto-Record — content script.
// Detects "in a live meeting" on Meet/Teams/Zoom web and reports JOIN/LEAVE/HEARTBEAT
// to the service worker, which talks to the local Pund-IT Meeting Assistant trigger server.
// v1.4.0 (PUN-801): SENSOR architecture — every frame reports raw signals every 2s;
// the worker merges per-tab and owns join/leave state. Fixes the split-frame case
// (video/controls in a same-origin subframe whose URL fails inMeetingPath — neither
// frame could fire JOIN alone; this made the extension trigger never fire on Meet).
// Debug tap (window.__meetilyLog/__meetilyTick/__meetilyCensus) kept.
(() => {
  if (window.__punditMeetingSensorInstalled) return;
  window.__punditMeetingSensorInstalled = true;
  // ---- debug mode ------------------------------------------------------------
  let DEBUG = false;
  const dbgLog = [];
  function dbg(m) {
    const line = `${new Date().toISOString().slice(11, 23)} ${m}`;
    dbgLog.push(line);
    if (dbgLog.length > 400) dbgLog.shift();
    window.__meetilyLog = dbgLog; // DevTools tap kept for bug reports
    if (DEBUG) console.debug('[Pund-IT Meeting Assistant]', line);
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

  const LEAVE_RE = /\b(leave|hang\s?up|end\s+call|end\s+the\s+call)\b/i;

  // Label-based leave detection (v1.4.0.2): field census 2026-10-02 10:55 proved the
  // in-call Meet DOM carries NO attr our selectors key on (no data-call-exit-id,
  // no data-tooltip="Leave") while button LABELS are fully populated. Scan labels.
  function leaveLabelHits() {
    const hits = [];
    for (const n of document.querySelectorAll('button, div[role="button"]')) {
      if (!isReallyVisible(n)) continue;
      const label = (n.getAttribute('aria-label') || n.getAttribute('data-tooltip') || (n.textContent || '')).trim();
      if (label && LEAVE_RE.test(label)) {
        hits.push(label.replace(/\s+/g, ' ').slice(0, 40));
        if (hits.length > 5) break;
      }
    }
    return hits;
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

  let beat = 0;
  // Raw per-frame signal snapshot. No local state machine: the worker merges
  // signals across ALL frames of the tab (top + same-origin subframes), because
  // Meet/Teams may split URL context (top) from UI/media (subframe).
  function gather() {
    const joined = leaveButtonVisible();
    const labelHits = leaveLabelHits();
    const pathOk = inMeetingPath();
    const media = mediaPlaying();
    const lobby = lobbyVisible();
    return { joined: joined || labelHits.length > 0, labelHits, pathOk, media, lobby, isTop: window.top === window };
  }

  function tick() {
    beat++;
    // MutationObserver-driven ticks can fire many times/sec on Meet; beacon at
    // most every 1.5s (worker recompute is per-beacon).
    const nowMs = Date.now();
    if (nowMs - (tick.lastSentAt || 0) < 1500) return;
    tick.lastSentAt = nowMs;
    const g = gather();
    // Beacon diagnostics: label hits make leave-detection truth visible in the log
    // (no more blind selector guessing — v1.4.0.2 field finding).
    dbg(`beacon pathOk=${g.pathOk} leave=${g.joined} media=${g.media} lobby=${g.lobby} top=${g.isTop}${g.labelHits.length ? ` labels=[${g.labelHits.join(' / ')}]` : ''} (probe: light=${probeState.lightMatches} vis=${probeState.visibleMatches} shadow=${probeState.shadowRoots}r/${probeState.shadowMatches}m "${probeState.sampleLabel}")`);
    // Census while a meeting URL is open but this frame shows no in-call signal —
    // including from subframes, so the worker log sees what each frame contains.
    // Census whenever this frame shows no in-call signal — subframes matter as
    // much as the top frame here (the mystery frame may be either). Throttled.
    if (!g.joined && !(g.media && !g.lobby)) {
      if (beat % 15 === 0) {
        try {
          const c = domCensus();
          dbg(`census: buttons=${c.visibleButtons}/${c.buttons} videos=${c.videos.length} iframes=${c.iframes.length} frame=${c.frames.top ? 'top' : 'sub'} labels=[${c.labels.slice(0, 8).join(' | ')}] data=[${c.dataAttrs.slice(0, 6).join(', ')}] iframesrc=[${c.iframes.slice(0, 3).join(' ; ')}]`);
        } catch (e) {
          dbg('census failed: ' + e);
        }
      }
    }
    try {
      chrome.runtime.sendMessage({
        kind: 'SENSOR',
        platform: platform(),
        meetingName: meetingTitle(),
        title: document.title,
        url: location.href,
        ...g,
      });
    } catch (_) {}
  }
  window.__meetilyTick = tick;
  dbg(`content script v1.4.0 loaded on ${location.hostname} fr${window.top === window ? 'TOP' : 'SUB'} (platform=${platform()})`);
  sendDebugTick('script-loaded', { url: location.href, title: document.title });

  // DevTools helpers for bug reports:
  //   __meetilyTick()                     — run one detection pass now
  //   __meetilyLog                        — ring buffer
  //   __meetilySelectorHits()             — which selectors have matched so far
  //   __meetilyCensus()                   — full DOM census (buttons/videos/iframes)
  window.__meetilySelectorHits = () => ({ ...selectorHits });
  window.__meetilyCensus = domCensus;

  // DOM census: ground truth of what this frame actually contains. Attached to
  // GET_TAB_DEBUG responses and the options-page probe — when detection fails,
  // this names the DOM we could (or could not) see instead of guessing selectors.
  function domCensus() {
    const isBtn = (n) => n.tagName === 'BUTTON' || n.getAttribute('role') === 'button';
    const buttons = [...document.querySelectorAll('button, div[role="button"]')];
    const visibleButtons = buttons.filter(isReallyVisible);
    const labelOf = (b) =>
      b.getAttribute('aria-label') || b.getAttribute('data-tooltip') ||
      (b.textContent || '').trim().slice(0, 30) || '(unlabeled)';
    const labelCounts = {};
    for (const b of visibleButtons.slice(0, 200)) {
      const l = labelOf(b);
      labelCounts[l] = (labelCounts[l] || 0) + 1;
    }
    const videos = [...document.querySelectorAll('video')].map((v) => ({
      w: v.videoWidth || 0, h: v.videoHeight || 0, visible: isReallyVisible(v),
    }));
    const iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 90));
    const frames = {
      top: window.top === window,
      frameCount: window.top === window ? 0 : 1,
    };
    const dataAttrs = {};
    for (const b of buttons.slice(0, 400)) {
      for (const a of b.attributes) {
        if (a.name.startsWith('data-')) {
          const key = a.name + (a.value ? '=' + a.value.slice(0, 24) : '');
          dataAttrs[key] = (dataAttrs[key] || 0) + 1;
        }
      }
    }
    const topData = Object.entries(dataAttrs).sort((x, y) => y[1] - x[1]).slice(0, 12)
      .map(([k, c]) => `${k}×${c}`);
    return {
      at: Date.now(),
      href: location.href,
      buttons: buttons.length,
      visibleButtons: visibleButtons.length,
      labels: Object.entries(labelCounts).map(([k, c]) => `${k}×${c}`).slice(0, 20),
      videos,
      iframes,
      frames,
      dataAttrs: topData,
      leaveSelectorsEverHit: Object.keys(selectorHits),
    };
  }

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
      const g = gather();
      sendResponse({ url: location.href, title: document.title, platform: platform(), log: dbgLog, signals: g, census: domCensus() });
      return true;
    }
    if (msg.kind === 'RECHECK_STATE') {
      sendResponse({ url: location.href, title: document.title, platform: platform(), signals: gather() });
      return true;
    }
    return false;
  });

  // Tell the worker this frame is going away (worker watches chrome.tabs too).
  window.addEventListener('pagehide', () => {
    try { chrome.runtime.sendMessage({ kind: 'FRAME_GONE', label: 'frame-unloading', url: location.href }); } catch (_) {}
  });

  console.log('[Pund-IT Meeting Assistant Auto-Record] content script v1.4.0 active on', location.hostname, window.top === window ? '(top frame)' : '(subframe)');
})();