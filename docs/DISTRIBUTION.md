# Pund-IT Meeting Assistant distribution

## Controlled Windows test delivery

Use `.github/workflows/build-rebrand.yml` on the integrated, reviewed rebrand branch. It calls the existing `build.yml` with the proven default Windows path, preserving Vulkan setup, `llama-helper`, native CMake portability hook, `RUSTFLAGS=-C target-cpu=x86-64-v2`, pre-bundle portability verification, and missing-key unsigned/updater fallback. No release ID is supplied. A guard rejects a release ID, non-default build args or a checkout that differs from the dispatch SHA in branded mode.

The reusable job retains its existing `contents: write` permission for compatibility with other release callers; this artifact-only caller supplies no release publication inputs. Normal release/build-test workflows are unchanged. Do not use `release.yml` for this test delivery.

The artifact name includes the full dispatch SHA, run ID and run attempt. Installer copies include the same provenance and `pund-it-meeting-assistant` brand prefix; original bundled bytes and any `.sig` files are preserved. `delivery-manifest.json` records original filenames, full source SHA, sizes and SHA-256 values. The helper refuses an existing output directory and requires an NSIS installer. Artifact retention is 30 days, not permanent distribution.

**Signing is not promised.** `sign-binaries: true` requests the existing conditional signing path; unavailable secrets can produce unsigned builds. A `.sig` is updater metadata, not Authenticode proof. Record `Get-AuthenticodeSignature` on the actual installer and payload separately. No new key/certificate setup or signing commitment is part of this rebrand.

## Operator build route (commands are instructions, not already executed)

Recovered from retained session `agent:main:dashboard:f491d30b-4457-4950-bac0-2b96b4cfd43b`, history offsets 65–75. Original Hermes host: `adrianna@170.205.18.98`, SSH port `8922`; existing root `gh` at `/usr/bin/gh`, root GitHub credential configuration `/root/.config/gh/hosts.yml` on that host. Local SSH password file: `/root/.openclaw/secrets/ssh-password`. Historical checkout: `/root/src/meetily`; original cache: `/root/.hermes/profiles/local-ollama/cache/`. These are locations only. Never print, copy or commit credential values. No authentication/policy changes are needed merely because the other host's local PAT returned HTTP403.

Read-only verification on 2026-10-03 confirmed original-host root `gh` identity `crashf` and run `37131569759` terminal success at `e86df852510ab879e8507577a2477a06917f7dfa`. No dispatch was performed in this documentation work. First verify existing authentication and the intended remote ref read-only:

```bash
sshpass -f /root/.openclaw/secrets/ssh-password ssh -p 8922 adrianna@170.205.18.98 \
  'sudo -n gh api user --jq .login'
sshpass -f /root/.openclaw/secrets/ssh-password ssh -p 8922 adrianna@170.205.18.98 \
  'sudo -n gh api repos/crashf/meetily/git/ref/heads/pundit/rebrand --jq .object.sha'
```

`pundit/rebrand` below is an example integrated branch: substitute the approved actual branch; do not dispatch the docs-only worker branch. After the parent has pushed/verified the integrated SHA and authorized a single build:

```bash
sshpass -f /root/.openclaw/secrets/ssh-password ssh -p 8922 adrianna@170.205.18.98 \
  'sudo -n gh workflow run build-rebrand.yml --repo crashf/meetily --ref pundit/rebrand'
sshpass -f /root/.openclaw/secrets/ssh-password ssh -p 8922 adrianna@170.205.18.98 \
  'sudo -n gh run list --repo crashf/meetily --workflow build-rebrand.yml --branch pundit/rebrand --limit 5 --json databaseId,headSha,status,conclusion,url'
```

Record `RUN_ID` and require its `headSha` to equal the approved full SHA. Check for an existing matching run before dispatching; do not duplicate a running build. The manual workflow must be registered/available in the repository; if GitHub cannot resolve the new workflow, inspect workflow availability before retrying. Registration/push are parent-owned gates, not an authentication blocker inferred from the local PAT.

On the authenticated host (or via the same SSH/root `gh` route), use the actual numeric run ID:

```bash
gh run view RUN_ID --repo crashf/meetily --json status,conclusion,headSha,jobs,url
gh api repos/crashf/meetily/actions/runs/RUN_ID/artifacts \
  --jq '.artifacts[] | {id,name,size_in_bytes,digest,expired}'
gh run download RUN_ID --repo crashf/meetily --name ARTIFACT_NAME --dir NEW_EMPTY_DIRECTORY
```

Require terminal success including Windows, verify artifact API metadata/digest (download the original ZIP via `gh api repos/crashf/meetily/actions/artifacts/ARTIFACT_ID/zip > artifact.zip` for archive hashing), then verify all manifest file hashes. Retain run metadata, ZIP, manifest, installer and extraction evidence under a unique evidence directory. Extract `meetily.exe` from NSIS with 7-Zip to hash packaged payload; extraction is not Windows execution. Installer and installed EXE hashes must match the selected delivery, not a prior run.

Historical proof of the route is run `37131569759`, source `e86df852510ab879e8507577a2477a06917f7dfa`; it is **not** evidence that the rebrand builds or runs. Earlier owner-dispatch/HTTP403 claims were superseded by original-host dispatch success. Retained logger delivery docs also record Wayne's later startup/summary-initiation acceptance, not all summary paths.

## Distribution gates

1. Integrate frontend/extension/docs changes without changing compatibility identifiers.
2. Complete mandatory OCR against the full launch range, triage findings and independently review.
3. Push/verify exact integrated source and authorize one artifact-only CI run.
4. Verify terminal Windows CI, unique artifact provenance, hashes and actual signature state.
5. Complete [fresh install and upgrade/data preservation](UPGRADE_TEST.md), including browser pairing and diagnostic/console checks.
6. Deliver only the selected approved test installer; retain old installer and data backups. Normal release replacement requires separate explicit approval.
