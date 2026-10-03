# PUN-827 native / extension branding delivery

Base: e86df852510ab879e8507577a2477a06917f7dfa.
Original component branch: pundit/rebrand-native. Installer correction branch:
pundit/rebrand-installer-fix, integration base ca94e265fef777e08a3c8f8879d8392e4b275510. Canonical Multica issue PUN-827
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
detection accepts both legacy and branded display names, requires the unchanged
exact publisher, and retains the upstream msiexec check. DisplayName, installer pages, version
resources and newly created shortcuts show Pund-IT Meeting Assistant.
MAINBINARYNAME, BUNDLEID, manufacturer, install mode and existing app-data
removal behavior are untouched. Existing install path continues to be read
from the legacy registry key. No application-data migration is introduced.

The copied template must be reconciled when the locked CLI is upgraded;
this source was not rendered or compiled by NSIS on this Linux host. Existing
legacy shortcuts can remain alongside the newly branded shortcut during an
in-place update. Creation/update preference behavior is unchanged. Non-update
uninstall now checks all three existing locations (selected Start Menu folder,
Start Menu root and desktop) for meetily.lnk and only unpins/deletes a link
when upstream IsShortcutTarget confirms the unchanged installed meetily.exe
target. Same-name links pointing elsewhere are preserved; directories are
removed only with the existing non-recursive RMDir behavior. /UPDATE skips
this cleanup. No shortcut migration or unconditional new shortcut is added.
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

Original native component suite: 5/5 pass. Installer correction suite now
contains 9 tests, including independently calculated UUIDv5, exact cleanup
blocks and full normalized upstream template SHA256; see correction evidence
below for the executed result.
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


## PUN-827 installer correction evidence (2026-10-03)

Exact source confirmed against Tauri tag tauri-cli-v2.11.1,
crates/tauri-bundler/src/bundle/windows/msi/mod.rs:588-600: default WiX
UpgradeCode is UUIDv5(DNS, productName + ".exe.app.x64"). Python uuid.uuid5
and an independent Node SHA1/UUID version+variant implementation both yield
293c4b6a-4aa1-5ef8-9cfd-823fc6139987 for meetily. bundle.windows.wix.upgradeCode
now pins that legacy upgrade family. The installed exact CLI 2.11.1
config.schema.json defines upgradeCode as a UUID string in WixConfig and
WindowsConfig references WixConfig. Both MSI/NSIS targets remain enabled;
no binary rename, storage identity or application-data behavior changed.
Verify the previously distributed MSI's actual UpgradeCode before shipping;
source-derived identity is not artifact acceptance.

Conditional legacy HKCU Run cleanup is inside the existing non-update guard.
Only an exact unquoted installed meetily.exe path or that exact path enclosed
in quotes permits deleting the meetily value. Different binaries/locations,
empty values, commands with arguments and ambiguous command lines are retained
conservatively; no prefix/substring matching or command execution is used.
The original branded PRODUCTNAME Run cleanup is unchanged. No current native
autostart writer was found by independent validation; this is compatibility
protection, not a claim that deployed installations contain the old value.

After removing only the two delimited cleanup additions and the original
legacy identity split, the entire template hashes to the independently
retrieved exact CLI 2.11.1 upstream SHA256:
ee84148e405adc4d736a46456dd8345a644751bd1f28a335dd7fd833a32d7c3e.
Thus all other NSIS text/control flow, including shortcut creation, /NS,
/UPDATE, silent/passive, install modes, data checkbox and registry detection,
remains byte-identical to the locked upstream template after normalization.

Executed correction checks: 9/9 branding/installer tests; combined Node
branding + delivery + portability suite; JSON schema field/type check;
independent Python UUID and exact-tag upstream template hash; git diff --check.
No native rendering, makensis, MSI compilation or Windows runtime was run.
Parent must integrate this isolated correction, independently validate it and
run full-range OCR/triage. Real legacy NSIS/MSI upgrade/final uninstall,
unrelated link/Run preservation, update mode, pinned shortcuts, actual MSI
identity, app data/preferences/token preservation and cross-bundle transitions
remain open. Branded MSI-to-NSIS name detection is not expanded by this fix.
No push, CI dispatch, release or Hub feature work. Rollback by excluding or
reverting this correction commit; never delete application data.
