# Pund-IT Meeting Assistant Auto-Record — Chrome extension (v1.1)

Companion MV3 extension for the Pund-IT Meeting Assistant desktop app. Detects when you join a
meeting in the browser (Google Meet, Teams web, Zoom web) and tells the local
Pund-IT Meeting Assistant app to start recording automatically via a loopback-only HTTP trigger
endpoint. Leaving the meeting stops the recording.

## Install (dev / unpacked)

1. Build/install the forked Pund-IT Meeting Assistant app first — Settings → Preferences →
   Auto-record shows the trigger endpoint `http://127.0.0.1:7788/trigger` and the
   access token (click the copy icon).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select this `extension/` directory (or unpack the zip and select it).
   **Important: whenever you update the extension, click reload (circular arrow)
   on its card, and reload any already-open meeting tabs** — content scripts in
   existing tabs keep running the OLD version until the tab reloads.
3. Open the extension's **Options** (Details → Extension options), paste the
   token, confirm the port, click **Test connection** → expect ✓ Pund-IT Meeting Assistant reachable.
4. (Optional) In Options, tick **Debug mode** — adds verbose logging and a live
   log viewer here (worker state machine + per-tab detection logs).
5. Join any Meet/Teams/Zoom meeting in Chrome. You get a **"Meeting detected"**
   notification, then **"Recording started"**. Pund-IT Meeting Assistant starts recording within
   ~4 s of the meeting UI being live; leaving stops within ~10 s.

## Notifications & debugging

- The extension fires a notification when it detects a meeting, when recording
  starts, when it stops (with reason), and on errors (Pund-IT Meeting Assistant unreachable,
  token rejected, server busy). Toggle in Options.
- **Debug mode** (Options toggle) enables a live log viewer in the options page:
  the worker's state machine + transport log, plus each open meeting tab's own
  detection log (state transitions, selector hits, URL checks). Use
  **Copy debug log** and paste it into a bug report.
- On a meeting page you can also open DevTools and use `__meetilyLog`,
  `__meetilyTick()` (run one detection pass now) and `__meetilySelectorHits()`.
- In the Pund-IT Meeting Assistant app: Settings → Preferences → Auto-record → **Debug &
  diagnostics** → Show — live ring-buffer of the app side (trigger server
  requests, 401s, gate probe status, deadman), test-notification button, and an
  opt-in file debug log (`AppData\Roaming\com.meetily.ai\auto_record_debug.log`,
  rotates at 1 MB).

## How detection works

- Content script matches meeting-platform URLs, then looks for a *visible*
  leave/hang-up button (multi-locale aria-label candidates + data attributes) and
  a real meeting URL pattern — this distinguishes an actual call from the lobby.
- Join must be observed for ~4 s (2 ticks) so pre-join screens don't trigger.
- Leave requires ~8 s absence to ride out UI popups, then POSTs stop.
- Heartbeats every ~2 s while in-meeting (plus a 15 s alarm): Pund-IT Meeting Assistant's deadman
  stops any orphaned recording 5 min after the browser dies mid-meeting.
- Worker meeting state survives MV3 restarts (storage.session); after a Chrome
  restart mid-meeting the next HEARTBEAT resumes the session.

## Security notes

- Server binds only to 127.0.0.1 and requires the Bearer token (random per
  install, shown in app settings). Requests from other sites are blocked by
  CORS/preflight + token, so a webpage cannot silently trigger recording.
- Extension keeps the token in chrome.storage.local (per-profile).
- Debug log contains meeting titles/URLs — it stays on-device; only paste it
  into bug reports you trust.