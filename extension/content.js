// Meetily Auto-Record — content script.
// Detects "in a live meeting" on Meet/Teams/Zoom web and reports JOIN/LEAVE/HEARTBEAT
// to the service worker, which talks to the local Meetily trigger server.
// Detection is resilient to UI changes: several selector candidates + URL heuristics.
(() => {
  const LEAVE_SELECTORS = [
    // Google Meet (multi-locale: aria-label varies, button carries data props)
    'button[data-call-exit-id][aria-label*="eave"]',
    'button[data-tooltip*="Leave"]',
    'div[role="button"][aria-label*="eave"], div[role="button"][aria-label*="Leave"]',
    // Teams web (Leave / Hang up)
    'button[aria-label*="eave"], button[aria-label*="ang up"], button[aria-label*="ang op"]',
    'button[title*="eave"], button[id*="phone-hangup"]',
    // Zoom web client
    'button.leave-btn, .footer-button__wrapper button[aria-label*="eave"], button[aria-label*="End"]',
    'div[role="button"][aria-label*="eave"]'
  ];

  const isGoogleMeet = () => location.hostname === 'meet.google.com';
  const isTeams = () =>
    /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|m365\.cloud\.microsoft)$/i.test(location.hostname);
  const isZoom = () => location.hostname.endsWith('zoom.us');
  const platform = () => (isGoogleMeet() ? 'google_meet' : isTeams() ? 'teams' : isZoom() ? 'zoom' : 'unknown');

  // URL stage detection: a real meeting URL (post/pre-join) vs homepage.
  function inMeetingPath() {
    if (isGoogleMeet()) return /^\/[a-z]{3}-[a-z]{4}-[a-z]{5}(\/|$)/i.test(location.pathname);
    if (isTeams()) return /(\/meeting[^\/]*|\/call|[#&?]conversation=)/i.test(location.href);
    if (isZoom()) return /\/wc\/|\/j\//i.test(location.pathname);
    return false;
  }

  // Meeting title extraction (best effort).
  function meetingTitle() {
    let t = document.title || '';
    t = t.replace(/\s*\|\s*(Google Meet|Microsoft Teams|Zoom)\s*$/i, '').trim();
    // Meet call pages title = meeting code-ish until renamed; Teams = "Meeting | Chat name"
    if (isGoogleMeet() && /^[a-z]{3}-[a-z]{4}-[a-z]{5}$/i.test(t)) {
      return t.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/([A-Z])/g, ' $1').trim();
    }
    if (isTeams()) {
      const parts = t.split(/\s*\|\s*/);
      const meetingish = parts.find((p) => /meeting|call/i.test(p)) || parts[parts.length - 1];
      return meetingish.trim();
    }
    return t || platform();
  }

  function leaveButtonVisible() {
    for (const sel of LEAVE_SELECTORS) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const n of nodes) {
          const r = n.getBoundingClientRect();
          // Only count it if the element actually renders (some platforms keep hidden templates).
          if (r.width > 0 && r.height > 0 && n.offsetParent !== null) return true;
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

  // Debug tap: window.__meetilyLog (array) + window.__meetilyTick() to run one
  // detection pass on demand from DevTools; dump it in bug reports.
  window.__meetilyLog = [];
  const dbg = (m) => {
    window.__meetilyLog.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
    if (window.__meetilyLog.length > 400) window.__meetilyLog.shift();
  };

  function tick() {
    dbg(`state=${state} leaveVisible=${leaveButtonVisible()} pathOk=${inMeetingPath()}`);
    const joined = leaveButtonVisible();
    const pathOk = inMeetingPath();

    if (state === 'IDLE') {
      if (pathOk && joined) {
        // Confirm for 2 consecutive ticks (~4s) to skip transient join screens.
        if (joinSeenAt === 0) {
          joinSeenAt = Date.now();
          state = 'JOINING';
        }
      } else {
        joinSeenAt = 0;
      }
    } else if (state === 'JOINING') {
      if (joined && pathOk) {
        if (Date.now() - joinSeenAt > 3000) {
          state = 'IN_MEETING';
          send('JOIN', { meeting_name: meetingTitle() });
        }
      } else if (Date.now() - joinSeenAt > 30000) {
        state = 'IDLE'; // false join; back off
        joinSeenAt = 0;
      }
    } else if (state === 'IN_MEETING') {
      if (joined && pathOk) {
        send('HEARTBEAT');
      } else {
        // Require 2 consecutive absent ticks to debounce UI hiccups.
        if (tick.absentSince === 0) {
          tick.absentSince = Date.now();
        } else if (Date.now() - tick.absentSince > 8000) {
          state = 'IDLE';
          tick.absentSince = 0;
          send('LEAVE');
        }
      }
      if (joined && pathOk) tick.absentSince = 0;
    }
  }
  tick.absentSince = 0;
  window.__meetilyTick = tick;
  dbg('content script loaded on ' + location.hostname);

  // Observe DOM + URL changes; poll as fallback every 2s (cheap: selector scan only).
  setInterval(tick, 2000);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      tick();
    }
  }, 1000);
  new MutationObserver(() => tick()).observe(document.body, { childList: true, subtree: true });

  // Tell the worker this tab closed (worker also watches chrome.tabs, this is belt & braces).
  window.addEventListener('beforeunload', () => {
    if (state === 'IN_MEETING') send('LEAVE', { closing: true });
  });

  console.log('[Meetily Auto-Record] content script active on', location.hostname);
})();