# PUN-827 native / extension branding delivery

Base: e86df852510ab879e8507577a2477a06917f7dfa.
Branch: pundit/rebrand-native. Canonical Multica issue PUN-827
(71e66744-97e8-4e4b-bd4c-e5550e05c90c), project
91c43201-63dc-4d51-a557-88fe0d52e872. No push, release or Windows build.

## Display changes

Desktop product/window title, tray tooltip, all native notification titles,
trigger-server diagnostic/help messages and transcription recovery instruction
use Pund-IT Meeting Assistant. Archived lib_old_complex notification titles are
also branded. Extension name, action title, options/help/status messages,
notifications, debug labels and README use the product name. Extension icons
are newly drawn microphone graphics (16/48/128 PNG); desktop icons belong to
another worker and are untouched. Cargo product description/authorship,
repository links and executable identifiers are not changed.

## Installer identity inventory and compatibility

A productName-only rename is NOT an identity-preserving NSIS change. The Tauri
NSIS template uses PRODUCTNAME for uninstall registry key, manufacturer/product
registry key, default install directory, WiX predecessor detection, shortcuts,
installer display and version resources. Keeping com.meetily.ai alone would
not preserve NSIS existing-install detection.

config/installer-compat.nsi is based on the exact frontend/pnpm-lock.yaml CLI
2.11.1 upstream template:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
Upstream Tauri copyright/licensing applies (MIT or Apache-2.0); retain upstream
project notices. The local template separates LEGACYPRODUCTNAME=meetily from
PRODUCTNAME. Legacy uninstall/manufacturer registry keys, placeholder/default
install directory and multiuser directory remain meetily. WiX predecessor
name+publisher detection remains legacy. DisplayName, installer pages, version
resources and newly created shortcuts show Pund-IT Meeting Assistant.
MAINBINARYNAME, BUNDLEID, manufacturer, install mode and existing app-data
removal behavior are untouched. Existing install path continues to be read
from the legacy registry key. No application-data migration is introduced.

The copied template must be reconciled when the locked CLI is upgraded;
this source was not rendered or compiled by NSIS on this Linux host. Existing
legacy shortcuts can remain alongside the newly branded shortcut when doing
an in-place update; deleting/renaming old shortcuts is intentionally avoided.
Actual Windows fresh install, same-version reinstall, upgrade, uninstall,
MSI-to-NSIS detection and data/token preservation remain UNVERIFIED. MSI,
macOS and Linux display/package effects also need artifact/runtime validation.
Do not interpret the static template checks as upgrade acceptance.

## Preserved identifiers / residual allowlist

- Cargo package meetily, library app_lib, native executable/process meetily,
  bundle identifier com.meetily.ai, version and updater key/endpoint.
- All SQLite migrations, native DB/storage/preferences sources and JSON
  templates; Meetily model/template folders, meetily-recordings folders,
  notification settings directory, meetily.log and startup-diagnostic.log.
- MEETILY_LLAMA_HELPER override, model source URLs, download user agents,
  temporary decoder prefix and audio-tap identifier.
- Console commands filtering process meetily; historical policy attribution.
- Extension __meetilyLog/__meetilyTick/__meetilySelectorHits/__meetilyCensus
  debug API, meetily-hb alarm and meetily-force-start/stop menu IDs.
- Every extension storage key, token/port pairing, message type, endpoint,
  HTTP verb, auth header, match/host pattern, permission, version, icon path,
  notification ID/throttle key and recording state-machine operation.
- README literal com.meetily.ai diagnostic path is intentional.
- Legacy NSIS registry/directory identity; source/template third-party notices.

## Evidence and remaining gates

node --test frontend/src-tauri/tests/branding-invariants.test.cjs: 5/5 pass.
Tests compare base/current configuration structurally, extension manifest
nonpresentation fields, exact extension presentation-only substitutions,
Rust presentation-only substitutions and key unchanged storage/logger files;
PNG dimensions and explicit NSIS legacy/display identities are checked.
node --check extension/background.js, content.js, options.js: all pass.
git diff --check: pass. Normal /root/src/meetily checkout remains untouched.
Rust compilation/tests/rustfmt were not run: cargo/rustfmt are unavailable
on this host. Extension Chrome load/runtime and graphics appearance are not
validated. Logger registration code in lib.rs/main.rs is byte-identical to
the tested base; Tauri remains the single logger, diagnostic path unchanged.
No OCR review is claimed; completed full-range OCR with findings triage is
required before the combined rebrand is shipped. Existing normal release
remains untouched. Rollback this isolated source component by excluding or
reverting its commit; do not delete application data.
