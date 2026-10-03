# Branding and compatibility inventory

Product-facing documentation uses **Pund-IT Meeting Assistant**. Root README no longer promotes upstream PRO/Enterprise offers, coupons, social/community links, upstream download badges or upstream-branded screenshots. Upstream MIT attribution and third-party acknowledgments remain.

## Intentional residual names

- `meetily.exe`, Rust crates/binary names and `llama-helper`: packaging/runtime identifiers, not display branding.
- `com.meetily.ai`, existing `meetily`/`Meetily` model/data/log folders and persisted preference keys: preserve continuity; no undocumented migration.
- Extension bearer token, port and loopback routes: protocol/pairing compatibility, not marketing.
- `MEETILY_RSA_PUBLIC_KEY` and other existing CI secret/configuration identifiers: build compatibility; no replacement credentials introduced.
- Existing release/test workflow artifact prefixes and upstream-origin source URLs: historical/provenance or unchanged normal-release paths. The new controlled Windows workflow emits uniquely branded delivery copies.
- `docs/Meetily-6.png`, older screenshots/GIFs: legacy asset filenames; root docs no longer embed these as current branded UI. Frontend/icon replacement is owned by the separate worker.
- `Meetily_<version>_amd64.AppImage` in legacy build-guide examples and `Meetily` model-folder examples in `CLAUDE.md`: compatibility/legacy filenames, not new distribution promises. Inspect actual output paths for the selected build.
- [Upstream Meetily](https://github.com/Zackriya-Solutions/meetily), Zackriya Solutions copyright, MIT and third-party notices: legal attribution, never remove or rewrite required notices.

Root/docs documentation and CI delivery are separate from frontend/extension implementation. No Hub features, identifier migrations or new signing guarantees are included. Before distribution, inspect the integrated inventory across UI, metadata, icons, notifications, extension and installer; residual technical/attribution names do not excuse remaining product-facing upstream promotions.

## Tracking

Canonical Multica: PUN-827, issue `71e66744-97e8-4e4b-bd4c-e5550e05c90c`, project `91c43201-63dc-4d51-a557-88fe0d52e872`. Audit/logger delivery references are retained in the operator workspace `projects/meeting-recorder-windows/`. Broader issue remains open for integration, review, exact-SHA CI and Windows upgrade acceptance.
