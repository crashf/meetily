//! Dependency-free lifecycle policy; also executable with rustc --test.
use std::sync::Mutex;
#[derive(Default)]
struct State {
    stop_epoch: u64,
    acknowledged: u64,
    pending: usize,
    generation: u64,
}
pub struct Lifecycle(Mutex<State>);
impl Lifecycle {
    pub const fn new() -> Self {
        Self(Mutex::new(State {
            stop_epoch: 0,
            acknowledged: 0,
            pending: 0,
            generation: 0,
        }))
    }
    pub fn epoch(&self) -> u64 {
        self.0.lock().unwrap().stop_epoch
    }
    pub fn generation(&self) -> u64 {
        self.0.lock().unwrap().generation
    }
    pub fn requested(&self) -> bool {
        let s = self.0.lock().unwrap();
        s.pending > 0 || s.stop_epoch != s.acknowledged
    }
    pub fn pending(&self) -> bool {
        self.0.lock().unwrap().pending > 0
    }
    pub fn request_stop(&self) -> StopIntent<'_> {
        let mut s = self.0.lock().unwrap();
        s.stop_epoch += 1;
        s.pending += 1;
        StopIntent(self)
    }
    pub fn allows_start(&self, epoch: u64) -> bool {
        let s = self.0.lock().unwrap();
        s.pending == 0 && s.stop_epoch == epoch
    }
    // Failed starts get cleanup identity without acknowledging stop intent or capture.
    pub fn failed_start(&self) -> u64 {
        let mut s = self.0.lock().unwrap();
        s.generation += 1;
        s.generation
    }
    // A slow start may acknowledge only intent observed before it began.
    pub fn started(&self, epoch: u64) {
        let mut s = self.0.lock().unwrap();
        s.generation += 1;
        s.acknowledged = epoch;
    }
}
pub struct StopIntent<'a>(&'a Lifecycle);
impl Drop for StopIntent<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().pending -= 1;
    }
}

/// Completed destructive phases must never be replayed. A failed pipeline join
/// is irreversible: keep its error sticky rather than report success on retry.
#[derive(Default)]
pub struct ShutdownProgress {
    pub streams_stopped: bool,
    pub pipeline_stopped: bool,
    pub terminal_error: Option<String>,
}
impl ShutdownProgress {
    pub fn stream_result(&mut self, result: Result<(), String>) -> Result<(), String> {
        match result {
            Ok(()) => {
                self.streams_stopped = true;
                Ok(())
            }
            Err(e) => {
                self.terminal_error = Some(e.clone());
                Err(e)
            }
        }
    }
    pub fn pipeline_result(&mut self, result: Result<(), String>) -> Result<(), String> {
        match result {
            Ok(()) => {
                self.pipeline_stopped = true;
                Ok(())
            }
            Err(e) => {
                self.terminal_error = Some(e.clone());
                Err(e)
            }
        }
    }
    pub fn check(&self) -> Result<(), String> {
        match &self.terminal_error {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
}
/// Millisecond-based gate rearm policy; missing probes never count as silence.
#[derive(Default)]
pub struct GateRearm {
    epoch: u64,
    quiet_since: Option<u64>,
    quiet_epoch: u64,
}
impl GateRearm {
    pub fn interrupt_quiet(&mut self) { self.quiet_since = None; }
    pub fn allows(
        &mut self,
        epoch: u64,
        pending: bool,
        speech: bool,
        healthy: bool,
        now: u64,
        silence_ms: u64,
    ) -> bool {
        if self.quiet_epoch != epoch {
            self.quiet_epoch = epoch;
            self.quiet_since = None;
        }
        if self.epoch != epoch {
            if speech || !healthy || pending {
                self.quiet_since = None;
            } else if now.saturating_sub(*self.quiet_since.get_or_insert(now)) >= silence_ms {
                self.epoch = epoch;
                self.quiet_since = None;
            }
        }
        self.epoch == epoch && !pending
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_during_slow_start_survives_finalize() {
        let l = Lifecycle::new();
        let e = l.epoch();
        let stop = l.request_stop();
        l.started(e);
        assert!(l.requested());
        drop(stop);
        assert!(l.requested());
    }
    #[test]
    fn queued_start_invalidated_even_after_stop_finishes() {
        let l = Lifecycle::new();
        let e = l.epoch();
        drop(l.request_stop());
        assert!(!l.allows_start(e));
        assert!(l.allows_start(l.epoch()));
    }
    #[test]
    fn overlapping_stop_intents_remain_visible() {
        let l = Lifecycle::new();
        let a = l.request_stop();
        let b = l.request_stop();
        drop(a);
        assert!(l.pending());
        l.started(l.epoch());
        assert!(l.requested());
        drop(b);
        assert!(!l.pending());
    }
    #[test]
    fn stale_watchdog_generation_cannot_own_new_recording() {
        let l = Lifecycle::new();
        l.started(0);
        let old = l.generation();
        l.started(0);
        assert_ne!(old, l.generation());
    }
    #[test]
    fn consumed_stream_failure_retains_failure_on_retry() {
        let mut p = ShutdownProgress::default();
        assert!(p
            .stream_result(Err("injected consumed stream failure".into()))
            .is_err());
        assert!(p.check().is_err());
        assert!(!p.streams_stopped);
        assert!(!p.pipeline_stopped);
    }
    #[test]
    fn successful_partial_shutdown_skips_completed_phases_on_retry() {
        let mut p = ShutdownProgress::default();
        let mut streams = 0;
        let mut flushes = 0;
        let mut handoffs = 0;
        for _ in 0..2 {
            p.check().unwrap();
            if !p.streams_stopped {
                streams += 1;
                p.stream_result(Ok(())).unwrap();
            }
            if !p.pipeline_stopped {
                flushes += 1;
                p.pipeline_result(Ok(())).unwrap();
                if handoffs == 0 {
                    handoffs += 1;
                }
            }
        }
        assert_eq!((streams, flushes, handoffs), (1, 1, 1));
    }
    #[test]
    fn consumed_failed_flush_never_becomes_success_on_retry() {
        let mut p = ShutdownProgress::default();
        p.stream_result(Ok(())).unwrap();
        assert!(p
            .pipeline_result(Err("injected flush failure".into()))
            .is_err());
        assert!(p.check().is_err());
        assert!(p.streams_stopped);
        assert!(!p.pipeline_stopped);
    }
    #[test]
    fn explicit_stop_suppresses_speech_and_requires_unbroken_healthy_silence() {
        let mut g = GateRearm::default();
        assert!(!g.allows(1, false, true, true, 0, 60));
        assert!(!g.allows(1, false, false, true, 10, 60));
        assert!(!g.allows(1, false, true, true, 50, 60));
        assert!(!g.allows(1, false, false, true, 55, 60));
        assert!(!g.allows(1, false, false, false, 110, 60));
        assert!(!g.allows(1, false, false, true, 120, 60));
        assert!(g.allows(1, false, false, true, 180, 60));
        assert!(!g.allows(2, true, false, true, 190, 60));
        assert!(!g.allows(2, false, true, true, 999, 60));
    }
    #[test]
    fn second_idle_stop_epoch_restarts_quiet_countdown() {
        let mut g = GateRearm::default();
        assert!(!g.allows(1, false, false, true, 10, 60));
        assert!(!g.allows(2, false, false, true, 50, 60));
        assert!(!g.allows(2, false, false, true, 70, 60));
        assert!(g.allows(2, false, false, true, 110, 60));
    }
    #[test]
    fn disabled_monitoring_resets_healthy_silence() {
        let mut g = GateRearm::default();
        assert!(!g.allows(1, false, false, true, 10, 60));
        assert!(!g.allows(1, false, false, false, 30, 60));
        assert!(!g.allows(1, false, false, true, 100, 60));
        assert!(g.allows(1, false, false, true, 160, 60));
    }

}

/// Count all admitted extension starts, including those waiting for trigger lock.
pub struct PendingStarts(std::sync::atomic::AtomicUsize);
impl PendingStarts {
    pub const fn new() -> Self { Self(std::sync::atomic::AtomicUsize::new(0)) }
    pub fn register(&self) -> PendingStart<'_> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        PendingStart(self)
    }
    pub fn any(&self) -> bool { self.0.load(std::sync::atomic::Ordering::SeqCst) != 0 }
}
pub struct PendingStart<'a>(&'a PendingStarts);
impl Drop for PendingStart<'_> {
    fn drop(&mut self) { self.0.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); }
}
#[test]
fn pending_start_tickets_cover_waiters_and_cancel_all_pre_stop_epochs() {
    let tickets = PendingStarts::new(); let lifecycle = Lifecycle::new();
    let epoch = lifecycle.epoch(); let first = tickets.register(); let second = tickets.register();
    assert!(tickets.any()); let stop = lifecycle.request_stop(); drop(first);
    assert!(tickets.any()); drop(stop); assert!(!lifecycle.allows_start(epoch));
    drop(second); assert!(!tickets.any());
    assert!(lifecycle.allows_start(lifecycle.epoch()));
}

/// Targeted cancellation does not mutate global native/gate stop policy.
struct RequestEntry { cancelled: bool, refs: usize, at: std::time::Instant }
pub struct ExtensionRequests(Mutex<Option<std::collections::HashMap<String, RequestEntry>>>, Mutex<Option<std::time::Instant>>);
impl ExtensionRequests {
    pub const fn new() -> Self { Self(Mutex::new(None), Mutex::new(None)) }
    pub fn register(&self, id: String) -> ExtensionRequest<'_> {
        let mut guard = self.0.lock().unwrap();
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        map.retain(|_, e| e.refs > 0 || e.at.elapsed().as_secs() < 300);
        if map.len() >= 4096 && !map.contains_key(&id) { return ExtensionRequest(self, id, false); }
        let saturated = self.1.lock().unwrap().as_ref().map_or(false, |at| at.elapsed().as_secs() < 300);
        let entry = map.entry(id.clone()).or_insert(RequestEntry { cancelled: saturated, refs: 0, at: std::time::Instant::now() });
        entry.refs += 1;
        ExtensionRequest(self, id, true)
    }
    pub fn is_cancelled(&self, id: &str) -> bool { self.0.lock().unwrap().as_ref().and_then(|m| m.get(id)).map_or(true, |e| e.cancelled) }
    pub fn cancel(&self, id: &str) {
        let mut guard = self.0.lock().unwrap();
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        // HTTP reads and extension request lifetime are bounded30s. Preserve
        // cancellation tombstones for5minutes; never prune live registrations.
        map.retain(|_, e| e.refs > 0 || e.at.elapsed().as_secs() < 300);
        if map.len() >= 4096 && !map.contains_key(id) {
            *self.1.lock().unwrap() = Some(std::time::Instant::now());
            return;
        }
        let entry = map.entry(id.to_string()).or_insert(RequestEntry { cancelled: true, refs: 0, at: std::time::Instant::now() });
        entry.cancelled = true; entry.at = std::time::Instant::now();
    }
}
pub struct ExtensionRequest<'a>(&'a ExtensionRequests, String, bool);
impl ExtensionRequest<'_> {
    pub fn cancelled(&self) -> bool { !self.2 || self.0.0.lock().unwrap().as_ref().and_then(|m| m.get(&self.1)).map_or(true, |e| e.cancelled) }
}
impl Drop for ExtensionRequest<'_> {
    fn drop(&mut self) {
        if !self.2 { return; }
        if let Some(e) = self.0.0.lock().unwrap().as_mut().and_then(|m| m.get_mut(&self.1)) { e.refs -= 1; }
    }
}
#[test]
fn targeted_extension_cancellation_never_invalidates_unrelated_native_start() {
    let requests = ExtensionRequests::new(); let native = Lifecycle::new(); let epoch = native.epoch();
    let first = requests.register("first".into()); let second = requests.register("second".into());
    requests.cancel("first");assert!(first.cancelled());assert!(!second.cancelled());assert!(native.allows_start(epoch));
    drop(first);requests.cancel("first");assert!(!second.cancelled());
}
#[test]
fn cancel_before_start_registration_is_sticky_and_new_identity_is_independent() {
    let requests = ExtensionRequests::new(); requests.cancel("late");
    let late = requests.register("late".into()); assert!(late.cancelled());
    let replacement = requests.register("replacement".into()); assert!(!replacement.cancelled());
    requests.cancel("late"); assert!(!replacement.cancelled());
}
#[test]
fn cancelled_identity_survives_drop_and_concurrent_ticket_lifetimes() {
 let requests=ExtensionRequests::new();requests.cancel("same");
 let a=requests.register("same".into());let b=requests.register("same".into());
 drop(a);assert!(b.cancelled());drop(b);
 let retry=requests.register("same".into());assert!(retry.cancelled());
}
#[test]
fn capacity_rejected_ticket_drop_cannot_decrement_later_tombstone() {
 let requests=ExtensionRequests::new();for n in 0..4096 { requests.cancel(&format!("id{}",n)); }
 let denied=requests.register("new".into());assert!(denied.cancelled());
 { let mut g=requests.0.lock().unwrap();g.as_mut().unwrap().clear(); }
 requests.cancel("new");drop(denied);
 let g=requests.0.lock().unwrap();assert_eq!(g.as_ref().unwrap()["new"].refs,0);
}

#[test]
fn saturation_cancellation_barrier_survives_capacity_expiry() {
 let requests=ExtensionRequests::new(); for n in 0..4096 { requests.cancel(&format!("old{}",n)); }
 requests.cancel("denied");
 { requests.0.lock().unwrap().as_mut().unwrap().clear(); }
 let delayed=requests.register("denied".into()); assert!(delayed.cancelled());
}
#[test]
fn interrupt_quiet_preserves_acknowledged_stop_epoch() {
 let mut gate=GateRearm::default();assert!(!gate.allows(1,false,false,true,0,60));assert!(gate.allows(1,false,false,true,60,60));
 gate.interrupt_quiet();assert!(gate.allows(1,false,true,true,61,60));
}

/// The decision used by both native start paths: unsuccessful rollback is an
/// owned resource, not an admission failure that can drop accepted audio.
pub fn retain_start_failure<T>(slot: &mut Option<T>, manager: T, needs_recovery: bool) -> bool {
    if needs_recovery { assert!(slot.is_none(), "cannot replace a recovery owner"); *slot = Some(manager); true } else { false }
}

/// Recovery releases its exact owner only after every independent phase is durable.
/// This transition never authorizes successful-save or summary handoff.
#[derive(Default)]
pub struct RecoveryCompletion {
    pub resources_closed: bool,
    pub audio_durable: bool,
    pub transcripts_drained: bool,
    pub transcripts_durable: bool,
}
impl RecoveryCompletion {
    pub fn release<T>(&self, owner: &mut Option<T>) -> Result<(), String> {
        if !(self.resources_closed && self.audio_durable && self.transcripts_drained && self.transcripts_durable) {
            return Err("recovery incomplete; exact owner retained".into());
        }
        owner.take();
        Ok(())
    }
}
#[cfg(test)]
mod recovery_completion_tests {
    use super::*;
    #[test] fn incomplete_audio_drain_or_persistence_retains_identity() {
        for missing in 0..4 {
            let owner = std::sync::Arc::new(vec![1,2,3]);let mut slot=Some(owner.clone());
            let mut done=RecoveryCompletion{resources_closed:true,audio_durable:true,transcripts_drained:true,transcripts_durable:true};
            match missing {0=>done.resources_closed=false,1=>done.audio_durable=false,2=>done.transcripts_drained=false,_=>done.transcripts_durable=false}
            assert!(done.release(&mut slot).is_err());assert!(std::sync::Arc::ptr_eq(slot.as_ref().unwrap(),&owner));
        }
    }
    #[test] fn completed_recovery_releases_without_successful_save_outcome() {
        let done=RecoveryCompletion{resources_closed:true,audio_durable:true,transcripts_drained:true,transcripts_durable:true};
        let mut slot=Some(vec![1,2,3]);assert_eq!(done.release(&mut slot),Ok(()));assert!(slot.is_none());
    }
}
