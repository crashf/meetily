# Meetily Auto-Record — Chrome extension

Companion MV3 extension for the Pund-IT Meetily fork. Detects when you join a
meeting in the browser (Google Meet, Teams web, Zoom web) and tells the local
Meetily app to start recording automatically via a loopback-only HTTP trigger
endpoint. Leaving the meeting stops the recording.

## Install (dev / unpacked)

1. Build/install the forked Meetily app first — Settings → Preferences →
   Auto-record shows the trigger endpoint `http://127.0.0.1:7788/trigger` and the
   access token (click the copy icon).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select this `extension/` directory.
3. Open the extension's **Options** (Details → Extension options), paste the
   token, confirm the port, click **Test connection** → expect ✓ Meetily reachable.
4. Join any Meet/Teams/Zoom meeting in Chrome. Meetily starts recording within
   ~4 s of the meeting UI being live; leaving the meeting stops within ~10 s.

## How detection works

- Content script matches meeting-platform URLs, then looks for a *visible*
  leave/hang-up button (multi-locale aria-label candidates + data attributes) and
  a real meeting URL pattern — this distinguishes an actual call from the lobby.
- Join must be observed for ~4 s (2 ticks) so pre-join screens don't trigger.
- Leave requires ~8 s absence to ride out UI popups, then POSTs stop.
- Heartbeats every ~2 s while in-meeting (plus a 15 s alarm): Meetily's deadman
  stops any orphaned recording 5 min after the browser dies mid-meeting.

## Security notes

- Server binds only to 127.0.0.1 and requires the Bearer token (random per
  install, shown in app settings). Requests from other sites are blocked by
  CORS/preflight + token, so a webpage cannot silently trigger recording.
- Extension keeps the token in chrome.storage.local (per-profile).