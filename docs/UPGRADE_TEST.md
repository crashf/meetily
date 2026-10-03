# Fresh install and upgrade/data-preservation acceptance

This is a **procedure, not completed runtime evidence**. Execute on a disposable Windows VM/test profile first, then an approved existing profile. Do not use production meeting content in tests.

## Establish the baseline

1. Record Windows/CPU/GPU details, source SHA, prior installer and installed EXE SHA-256, actual executable location, version and signature state. Record old shortcuts/tray behavior.
2. Create a known meeting with audio, transcript, title and summary. Record meeting count/IDs and confirm existing playback/export. Record model selection, audio devices, summary-provider selection and analytics preference without exposing API keys.
3. Confirm the extension is paired and its configured port/token still work. Do not paste token values into evidence; compare in-place or record a pass/fail result.
4. Discover the actual app-data/database/model/preference paths in this installation. `com.meetily.ai`, `meetily`, `Meetily` and `meetily.exe` may remain compatibility names. Do not assume a newly branded folder is the data root.
5. Fully quit the app and tray process. Back up the entire existing app-data tree, database plus any SQLite WAL/SHM files, model/audio folders and preferences with ACLs where practical. Record hashes/counts while quiescent. Secure backups contain sensitive data. Retain the old installer; no deletion/uninstall-with-data-removal.

## Install and verify

1. Verify selected CI run SHA and terminal success; download the uniquely named artifact, verify manifest and installer SHA-256. Record actual Authenticode state; do not infer signing from workflow flags.
2. Install the NSIS setup over the existing installation. Record installation folder and shortcuts. Ensure no side-by-side duplicate process/profile has been created.
3. Hash the installed `meetily.exe` and compare with the extracted payload for this installer. Verify Pund-IT display name, window/tray, About and installer surfaces; unchanged binary/storage names are expected.
4. Open the baseline meeting: same IDs/count, transcript/title/summary, audio playback/export and model availability. Compare preferences and pairing in-place. Database bytes may change on launch; use logical record equality plus pre-launch hashes, not an impossible unchanged-live-database requirement.
5. Make a new synthetic recording; stop and confirm one saved meeting/transcript and summary initiation/completion with a configured test provider. Test extension stop, manual stop and duplicate stop separately; do not generalize one path to all origins. Confirm no token regeneration or re-pairing requirement unless explicitly approved.
6. Exercise console/diagnostic behavior and restart the app. Inspect `%LOCALAPPDATA%\meetily\startup-diagnostic.log` where present; ensure no duplicate logger initialization panic. Review/redact logs before sharing.
7. Confirm local-only configuration and external-provider configuration separately; observe intended destination without logging content or keys. Confirm analytics preference survives upgrade. Optional network transfer must match the privacy disclosure.

## Fresh install and rollback

- On a fresh disposable profile, install and launch, configure a local model/provider, record synthetic audio, verify transcription/save/summary, browser pairing and restart. Record platform-specific gaps.
- If upgrade fails, quit all app processes and retain failed-build logs/backups. Reinstall the retained prior installer without deleting app data. Older binaries may not support a migrated database: restore the **quiescent pre-upgrade backup** in a test profile first, preserving the post-upgrade tree separately. Obtain approval before replacing user data. Never blindly downgrade against a changed database.
- Test uninstall only on the disposable profile; record whether user data is retained. Do not assert preservation based on installer branding or unchanged identifiers alone.

## Evidence and sign-off

Record per-step pass/fail, timestamps, exact source/run/artifact IDs, installer/payload hashes, signature result, OS/hardware, before/after logical counts/preferences, pairing continuity and rollback result. Keep sensitive backups outside public artifacts. Failures, untested paths and independent review/OCR findings remain explicit gates. Broad PUN-827 remains open until its integrated acceptance is satisfied.
