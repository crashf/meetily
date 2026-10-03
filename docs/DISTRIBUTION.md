# Pund-IT Meeting Assistant distribution

## Controlled Windows test delivery

Use the registered Build Test route described below on the integrated, reviewed rebrand branch. It calls the existing `build.yml` with the proven default Windows path, preserving Vulkan setup, `llama-helper`, native CMake portability hook, `RUSTFLAGS=-C target-cpu=x86-64-v2`, pre-bundle portability verification, and missing-key unsigned/updater fallback. No release ID is supplied. A guard rejects a release ID, non-default build args or a checkout that differs from the dispatch SHA in branded mode.

The reusable job retains its existing `contents: write` permission for compatibility with other release callers; this artifact-only caller supplies no release publication inputs. Normal release publication is unchanged. The branch-local Build Test caller enables branded Windows delivery only for the explicitly named rebrand branch. Do not use `release.yml` for this test delivery.

The artifact name includes the full dispatch SHA, run ID and run attempt. Installer copies include the same provenance and `pund-it-meeting-assistant` brand prefix; original bundled bytes and any `.sig` files are preserved. `delivery-manifest.json` records original filenames, full source SHA, sizes and SHA-256 values. The helper refuses an existing output directory and requires an NSIS installer. Artifact retention is 30 days, not permanent distribution.

**Signing is not promised.** `sign-binaries: true` requests the existing conditional signing path; unavailable secrets can produce unsigned builds. A `.sig` is updater metadata, not Authenticode proof. Record `Get-AuthenticodeSignature` on the actual installer and payload separately. No new key/certificate setup or signing commitment is part of this rebrand.

## Operator build route

Use the registered `Build Test` workflow (`build-test.yml`, workflow ID `372658384`) with the approved `pundit/meeting-assistant-rebrand` branch. The branch-local caller pins the reusable build to `${{ github.sha }}` and enables branded delivery only for its Windows matrix entry on this explicit branch. Other platform jobs retain ordinary test-artifact behavior. The separate `build-rebrand.yml` is a future Windows-only caller; it cannot be assumed dispatchable until registered on the default branch.

```bash
gh workflow run 372658384 --repo crashf/meetily --ref pundit/meeting-assistant-rebrand
gh run list --repo crashf/meetily --workflow build-test.yml --branch pundit/meeting-assistant-rebrand --limit 5 --json databaseId,headSha,status,conclusion,url
```

Use the existing authorized operator environment; internal access instructions are maintained privately, not in public source. Before dispatch, verify the remote branch SHA equals the reviewed full SHA and check for an existing matching run. Do not duplicate builds. Require the selected run's `headSha` to equal that separately approved SHA. No default-branch changes or new credentials are needed for this route.

```bash
gh run view RUN_ID --repo crashf/meetily --json status,conclusion,headSha,jobs,url
gh api repos/crashf/meetily/actions/runs/RUN_ID/artifacts --jq '.artifacts[] | {id,name,size_in_bytes,digest,expired}'
gh run download RUN_ID --repo crashf/meetily --name ARTIFACT_NAME --dir NEW_EMPTY_DIRECTORY
```

Require terminal success including Windows. Verify original artifact ZIP against the API digest, manifest file hashes, installer hash and extracted `meetily.exe` hash. Extracting a payload is not Windows execution or upgrade acceptance. Historical successful builds are route evidence only, not evidence that this rebrand builds or runs.

## Distribution gates

1. Integrate frontend/extension/docs changes without changing compatibility identifiers.
2. Complete mandatory OCR against the full launch range, triage findings and independently review.
3. Push/verify exact integrated source and authorize one artifact-only CI run.
4. Verify terminal Windows CI, unique artifact provenance, hashes and actual signature state.
5. Complete [fresh install and upgrade/data preservation](UPGRADE_TEST.md), including browser pairing and diagnostic/console checks.
6. Deliver only the selected approved test installer; retain old installer and data backups. Normal release replacement requires separate explicit approval.
