# Native lifecycle OCR repair (PUN-827)

Base e016aa2; attributed initial OCR findings at 189bb454 from canonical
`evidence/regression-delivery-20261004/ocr-live-reconciliation.log`.

Source-verified high: explicit native audio stop resurrection; queued server
starts surviving stop; watchdog stopping a later UI generation.
Source-verified medium: slow start erasing queued stop intent; duplicate gate
completion; premature watchdog success notification; manager swallowing
shutdown failures; structural-only failure-path assertion.

Repairs:
- Mutex-protected stop epochs + counted RAII pending intent. Slow start only
  acknowledges its captured epoch. Authenticated stop publishes before trigger
  queue; automatic starts validate their ticket under the engine lock.
- Gate requires 60 seconds uninterrupted healthy silence after explicit stop;
  speech, unavailable probes or pending stop resets rearm. Gate uses conditional
  generation stop and only emits completion on owning true outcome.
- Watchdog checks native generation and live heartbeat eligibility while holding
  the engine lock, then notifies only on successful owned finalization.
- Start lock now extends through listener/transcription setup (otherwise a stop
  could take the manager before the start had registered its resources).
- Pipeline flush/VAD/final segment/join failures propagate. Manager records
  completed destructive stages. A consumed failed stream or pipeline operation
  has a sticky terminal error: manager, listener and transcript task remain
  owned, no success handoff, repeated Stop cannot reinterpret missing resources
  as success. Completed stages are not replayed. This is intentionally NOT a
  promise that irrecoverably lost audio can be retried: recovery requires a
  separately designed discard/export path or process restart. Existing on-disk
  incremental checkpoints remain untouched.

Validation: `tests/native/run-policy-tests.sh` compiles the actual dependency-free
production policy with Rust 1.85.1 in disposable rust:1.85-slim container: 8/8
executable tests pass. Covers slow start/stop, pending overlap, stale queued
start and generation, interrupted healthy-silence rearm, consumed stream/flush
failure sticky ownership and completed-stage exactly-once progress.
`node --test tests/native/stop-lifecycle.test.cjs`: 5/5 wiring assertions, NOT
native integration tests. Rustfmt successfully parsed changed production Rust
in disposable container; git diff --check clean. No host installs/config edits.

Limitations: no full Tauri/native typecheck or real devices on this Linux host;
no native end-to-end injected stream/flush test (policy failure injection only).
Parent owns successor OCR, exact-SHA Windows CI and runtime acceptance.
No extension, identity/version/icons, logger, heartbeat verbs, DB/preferences,
pairing/updater or summary pipeline changes.

## Second-review repairs — 2026-10-04 local continuation

The second attributed session b5a604ff supplied 13 confirmed findings (5 High,
8 Medium). Manual starts now capture their epoch before awaiting engine ownership;
gate starts revalidate under trigger ownership and install session metadata only
following successful live-generation validation. No provisional session survives
supersession. Quiet countdowns track the target epoch and reset while disabled.
Both tray no-op stop handlers refresh their menu without emitting completion.

Failure recovery now drains the saver receiver using a one-shot close signal and
an owned join handle, then checkpoints the recoverable tail independently of the
sticky pipeline error. Accepted queued chunks are drained; no merge/checkpoint
cleanup or successful post-processing handoff occurs on failed shutdown. A failed
checkpoint retains its buffer for retry. Failed-stop mic replacements require
live state/identity and rejected streams are stopped outside the manager lock.

Executable verification: 10 dependency-free Rust policy tests and 85 Node tests
(including five new native wiring contracts and six extension race regressions).
Frontend noEmit, production build and generated-title test also pass locally.
These contracts are not full native execution, CPAL failure injection, Windows
compilation, installer acceptance or Windows runtime evidence. Full integrated
exact-SHA OCR is still a separate required gate after final source commit.

### Integrated successor review source repairs
Final integrated session5b0acab7 completed81/81 with12 comments. Confirmed
additional risks repaired: global native recording cannot be adopted as extension
ownership; native extension stops validate extension generation; heartbeat storage
failure does not skip renewal; final manual reservation reconciles failed/orphaned
handoff; old disappearance/stop badges revalidate after persistence. Stream failure
now still closes/joins pipeline before saver drain. Accumulation/save failures retain
recoverable tail and propagate failure rather than successful handoff. Inactive stale
gate metadata no longer blocks rearm; silence requires all expected probes fresh.
Signature sources reject symlinks; actual Rust post-processing source contracts use
owning stop outcome APIs and pass3/3 in dependency-free extraction.
Sticky terminal shutdown remains intentionally restart-required; no automatic
failure reset discards retained transcript ownership. This is a declared limitation,
not successful-stop semantics. Full native/Windows failure injection remains open.

### Cancellation/ownership successor
Session6dd52e7c completed81/81 at17eec7a,11 leads. Additional confirmed
cancellation/ownership risks repaired: accumulator join remains owned across
cancelled await with sticky failure; completed audio finalization path cached for
metadata retry; pipeline flush failures retained while accepted raw chunks drain;
late automatic acknowledgement with no owner queues stop; HTTP requests bounded
30seconds with AbortController, uncertain start queues native cancellation. Cached
acknowledgement reconciled live extension ownership, pending native extension
startup cancellation publishes intent and conditionally drains superseded start.
Probe callbacks independently update fresh silence/speech eligibility while gate
waits on locks. Mock models native owner conflict; replacement desktop session and
degraded worker are protected. Matching non-MSI installer entries continue MSI
enumeration with normalization-preservation guard and regression assertion.
97 executable Node tests,10 policy tests,3 compiled actual Rust source-contract
tests pass; these do not establish full native/Windows integration or CPAL failure
execution. Final integrated review must again target exact final source commit.

### Final81 successor local repair
Seven confirmed High source leads repaired: immediate shared cancellation transport
with serialized reconciliation; lost-response/abort ownerless cleanup; fresh automatic
owner transfer; counted RAII tickets before trigger lock; generation-scoped gate
cleanup with explicit retained retry/error owner; rejected stops preserve replacement
metadata; extension superseded cleanup retains retry ownership on failure.
104 Node checks,11 compiled production policy tests and3 extracted actual Rust
source contracts pass. Added reproducible extraction runner; source contracts do not
substitute for native Tauri compilation or device/Windows failure injection. Official
rocket assets and original13/prior fixes retained. Exact final integrated OCR remains
mandatory; board stays open for Windows CI/runtime acceptance.

### Exact7940ae2 successor review repairs
Terminal7c0de454 complete82/82,union9,8m24s. All nine actionable leads
repaired locally: durable per-start/session stop identity and targeted extension
cancellation independent of native manual/gate epoch; new tabs inherit stop
suppression; fail-closed ordering contracts; explicit authenticated exact-generation
failed-session recovery gated on terminal failure/closed resources/durable tail and
bounded transcript drain with no successful-save/handoff; recoverable checkpoint
errors resolve only after durable tail, task failure remains sticky; stale error
metadata retired conditionally; monotonic callback/GateRearm timing; error owners
never acknowledged as healthy starts.108 Node checks,13 compiled policy tests,
3 extracted actual Rust contracts. These are bounded evidence, not full Tauri or
Windows runtime. Mandatory exact successor full-range review still required.

### Exact fea9711 successor review repairs
Terminal40fff609 complete82/82,16 leads,10m41s.14 actionable leads fixed;
stream-error lead withdrawn after AudioStream::stop source verified alwaysOk.
UUID restoration/heartbeat, structured failed cleanup retry, real null-target mock,
transcript saver remains globally owned/listening until drain, sticky failed joins,
bounded counted cancellation tombstones, sameUUID idempotence, persisted sensor
freshness, fail-closed section checks, failed save recovery, required audio saver
absence error, no global HTTP intent against stale manual/gate metadata.
113 Node,14 production policy,3 extracted actual Rust contracts; native/Windows
runtime acceptance separate. Next exact final OCR remains mandatory.

### Exact2492cc3 review continuation
Terminal0e041e73 complete82/82 union15,9m50s.14 actionable defects repaired:
CRLF contracts,installer reparse fail-closed affected-tree checks,unreachable ping
owner retention,stale retry_stop,real restore clock/foreign-owner suppression,
capacity-admission ticket safety,temporary checkpoint publish,normal transcript
drain ownership,body-read abort,post-lock gate evidence,strict UUID query contract,
recovery transcript/metadata persistence,nonfatal started-notification failure.
Lead13 judgment rejected: successful actual durable save retry is intended, not a
false handoff; irrecoverable task/stream error remains sticky.120 Node15 policy3
extracted contracts pass. NSIS/FFmpeg failure/native/Windows runtime remain separate
verification, not claimed. Full exact final launch OCR still mandatory.

### Exact54d7b72 review continuation
Terminal504ae8cf complete82/82 union12,9m45s. All12 leads repaired:orphan
UUID handoff,never-transmitted durable identity cleanup,real nativeUUID mock,
NSIS numeric System registers/enumeration errors,saturation cancellation barrier,
session-owned transcript sink through manager-taken shutdown,file/directory sync,
partial folder initialization retry state,native-lock gate eligibility/config epoch,
continuous healthy probe silence.122 Node16 production policy3 extracted source
contracts. Full native/NSIS/CPAL/runtime separate; next exact final OCR required.

### Exact98e0490 review continuation
Terminal4a53f8ba complete82/82 union14,9m44s.13 leads repaired including
alarm harness,Windows writable synced file/MoveFileExW write-through publication,
transcript JSON envelope/durable persistence,query-bootUUID,.pending checkpoint
isolation,continuous healthy/callback silence/config epoch,disabled unsafe legacy
URL toggle. Installer TOCTOU residual remains: NSIS path-based File/Delete can
race a same-user writable-tree replacement after snapshot validation. Snapshot
checks are not handle-relative mutation proof; no elevated installer mode added.
123 Node16 policy3 extracted contracts pass; Windows adversarial/NSIS native
acceptance required, no fully hardened installer/readiness claim.

### Exact34a2e2d review continuation
Terminal985a70ca complete82/82 union9,8m12s. All9 direct actionable leads
repaired:appdata preflight before destructive uninstall,fail-closed section ordering,
actual stop timeout harness,unchanged config polling preserves silence,coherent
settings/epoch snapshot,one60s rearm timer,explicit failed-drain recovery preserves
available transcripts without save success,native-lock request-cancellation predicate,
transcripts-only final durable persistence.124 Node16 policy3 extracted contracts.
Installer path mutation TOCTOU residual from prior review still acknowledged;
Windows adversarial/native/NSIS runtime needed. Next exact final review required.

### Exact8b313d4 review continuation
Terminald9abfd72 complete82/82 union10,10m36s. Ten leads repaired:staged
artifact hashes,liveURL restore eligibility,frame-unload invalidation/observation
freshness,predecessor preflight before legacy uninstaller,shell-context restoration,
scoped stop contracts,rearm callback-discontinuity sequence,immediate ownerless
pending-start cancellation,config-epoch silence-stop eligibility,dark late-success
cleanupUUID.127 Node16 policy3 extracted contracts pass. Residual NSIS path-based
TOCTOU still acknowledged; Windows adversarial/runtime/native acceptance separate.

### Exact78d8d2d continuation and specific remaining limits
Terminal517aaef0 complete82/82 union9,9m17s. Direct repairs:explicit destroyed
frame invalidation,UUID-capable desktop protocol before lifecycle commands,
interrupted-start identity cleared on successful cleanup,dark evidence continuity,
quiet interruption preserves acknowledged stop epoch,decision-bound silence-stop
config epoch,eligibility rechecked immediately before capture.130 Node17 policy3
extracted contracts pass. Runtime connection credential snapshot preserves cleanup
across pairing edits without persisting token outside existing approved config.
Remaining source/procedure limits: old transport credentials cannot survive worker
restart after pairing edit without additional secret persistence design (not authorized);
NSIS same-user path mutation TOCTOU requires handle-relative Windows mutation
implementation/acceptance (local makensis absent); transcript sink durable per-event
I/O performance remains to replace with owned coalescing worker before claiming
performance readiness. These are not silently dismissed or claimed fixed.

### Exact49da3d2 review continuation
Terminal74c2b839 complete82/82 union7,9m6s.7 leads repaired:FRAME_GONE dark
debounce/replacement window,retained acknowledged240s ownership heartbeat,manager
pre-stream admission after50ms prep both start paths,validated MSI selected-path
fallback,atomic-only CPAL callbacks,sticky irrecoverable transcript-drain recovery
failure (restart/operator acknowledgement required),fail-closed test section helper.
132 Node17 policy3 extracted contracts. Final exact review pending; residual pairing
cross-worker secret design,NSIS handle-relative TOCTOU,transcript callback I/O
performance remain explicitly unaccepted, not local launch-ready.

### Exactaca9044 review continuation
Terminal8b5a231f complete82/82 union5,7m48s. All5 source leads repaired:
MSI fallback directory picker before reinstall page exit (silent fail-closed),FRAME_GONE
awaits bootReady,neutral stop completion notification,Send+Sync capture eligibility
trait object,nonzero required probe timestamps.132 Node17 policy3 extracted contracts
pass. Full nativeWindows/NSIS build remains separate gate; residual historical
pairing token restart/installerTOCTOU/transcriptI/O design limits still explicit.

### Exactdc64643 review and specific source/env blockers
55c28550 complete82/82 union7,11m20s. Pairing restart false cleanup fixed using
non-secret durable pairing digest and fail-closed mismatch; no historical token
saved. Post-stream eligibility rechecked/unwinds; dark leave alarm completes;
predecessor path retained for actual post-uninstall verification.134Node17policy3
contracts pass. Outstanding: silent NSIS predecessor discovery is in a custom page
and needs non-UI extraction/native NSIS fixtures; snapshot reparse checks cannot
prevent same-user path mutation TOCTOU. Local command-v makensis exit1; Windows
runtime absent. Per-event durable transcript callback I/O remains performance
lead needing owned coalescing writer/flush contract. These are genuine unresolved
source/design verification limits, not clean readiness. Event-level boot-delayed
FRAME_GONE coverage also needs extension harness expansion. No source-ready claim.

## Superseding bounded final lifecycle continuation
Historical per-event synchronous transcript callback I/O is repaired by the bounded session-owned coalescing writer; serialized final publication retains the segment snapshot until writer join. Native/Windows long-meeting performance acceptance remains open, not an unresolved synchronous-callback source claim. Historical installer migration/TOCTOU risks remain unresolved and outside current lifecycle authorization. Historical pairing tokens are not added to durable storage; mismatch retains targeted cleanup and disables renewal. See workspace evidence/local-final-lifecycle-20261004 for exact review attribution and dispositions.

Current scoped recovery supersedes historical restart-only guidance: release requires exact generation, closed resources, durable audio and successful transcript drain/publication, never successful-save/summary handoff. Sticky shutdown error alone does not prevent recovery; unclosed resources or recorded transcript loss still require explicit intervention.
