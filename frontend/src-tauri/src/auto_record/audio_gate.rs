// src/auto_record/audio_gate.rs
// Fallback trigger: watches mic + default system-output levels, debounces into
// "speech" state, and starts/stops recording when the extension doesn't.
// Windows/Linux: private cpal probe streams (mic input device; output loopback via
// the patched cpal used by the recording pipeline itself). macOS: mic probe only.
use super::{emit_event, load_config, now_ms, SessionMeta, STATE};
use cpal::Sample;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, Clone)]
struct LevelEvent {
    source: &'static str, // "mic" | "system"
    rms: f32,
    at: Instant,
}

// Probe callbacks update eligibility independently while the gate waits on locks.
static LIVE_THRESHOLD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static LAST_PROBE_MIC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LAST_PROBE_SYS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CALLBACK_SPEECH: Mutex<std::collections::VecDeque<(&'static str,u64,bool)>> = Mutex::new(std::collections::VecDeque::new());
fn fresh_sustained_speech() -> bool {
 let now=monotonic_ms();let events=CALLBACK_SPEECH.lock().unwrap();
 ["mic","system"].iter().any(|source|{let recent:Vec<_>=events.iter().filter(|(s,t,_)|s==source && now.saturating_sub(*t)<=START_WINDOW_MS).collect();recent.len()>=4 && recent.last().unwrap().1.saturating_sub(recent.first().unwrap().1)>=START_WINDOW_MS.saturating_sub(PROBE_INTERVAL_MS) && recent.iter().filter(|(_,_,above)|*above).count() as f32/recent.len() as f32>=START_RATIO})
}
static SYSTEM_AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LAST_PROBE_SPEECH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn monotonic_ms() -> u64 {
    static ORIGIN: once_cell::sync::Lazy<Instant> = once_cell::sync::Lazy::new(Instant::now);
    ORIGIN.elapsed().as_millis() as u64 + 1
}
static SILENCE_DISCONTINUITY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static HEALTHY_INTERVAL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static HEALTHY_SILENCE: Mutex<Option<u64>> = Mutex::new(None);
fn live_silence_eligible() -> bool {
    let now = monotonic_ms();
    let mic = LAST_PROBE_MIC.load(Ordering::SeqCst);
    let sys = LAST_PROBE_SYS.load(Ordering::SeqCst);
    let speech = LAST_PROBE_SPEECH.load(Ordering::SeqCst);
    let healthy = mic > 0 && now.saturating_sub(mic) < PROBE_STALE_MS as u64
        && (cfg!(target_os = "macos") || !SYSTEM_AVAILABLE.load(Ordering::SeqCst) || (sys > 0 && now.saturating_sub(sys) < PROBE_STALE_MS as u64));
    let mut interval = HEALTHY_SILENCE.lock().unwrap();
    let seq = SILENCE_DISCONTINUITY.load(Ordering::SeqCst);
    if HEALTHY_INTERVAL_SEQ.swap(seq, Ordering::SeqCst) != seq { *interval = None; }
    if !healthy || now.saturating_sub(speech) < PROBE_INTERVAL_MS { *interval = None; return false; }
    now.saturating_sub(*interval.get_or_insert(now)) >= SILENCE_STOP_MS

}

const PROBE_INTERVAL_MS: u64 = 1000;   // main loop tick
const START_WINDOW_MS: u64 = 2000;     // speech must fill this much recent history
const START_RATIO: f32 = 0.5;          // fraction of window events above threshold
const SILENCE_STOP_MS: u64 = 60_000;   // silence needed to auto-stop (gate-started sessions)
const DEVICE_RETRY_MS: u64 = 30_000;
const PROBE_STALE_MS: u128 = 15_000;   // no events this long => probe considered dead

fn cpal_config(sample_rate: u32, channels: u16) -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    }
}

/// Long-lived OS thread owning the non-Send cpal stream.
struct ProbeThread {
    #[allow(dead_code)] // retained for diagnostics/restart bookkeeping
    source: &'static str,
    // Lifetime contract: run() holds the ProbeThread bindings for the process
    // lifetime, so stop_tx is never *sent to*; dropping it (process exit or a
    // future restart path) closes the channel and the worker breaks out.
    #[allow(dead_code)]
    stop_tx: std::sync::mpsc::Sender<bool>,
}

impl ProbeThread {
    fn start<R: Runtime>(app: AppHandle<R>, source: &'static str, out: UnboundedSender<LevelEvent>) -> Self {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<bool>();
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name(format!("auto-record-probe-{}", source))
            .spawn(move || {
                Self::worker(app, source, out, stop_rx);
            });
        Self { source, stop_tx }
    }

    fn worker<R: Runtime>(
        app: AppHandle<R>,
        source: &'static str,
        out: UnboundedSender<LevelEvent>,
        stop_rx: std::sync::mpsc::Receiver<bool>,
    ) {
        loop {
            let opened=monotonic_ms();
            if source=="mic"{LAST_PROBE_MIC.store(0,Ordering::SeqCst);}else{LAST_PROBE_SYS.store(0,Ordering::SeqCst);}
            let original=if source=="mic"{crate::audio::recording_commands::resolve_default_mic()}else{crate::audio::recording_commands::resolve_default_system()}.map(|d|d.name.clone());
            match Self::open_stream(&app, source, out.clone()) {
                Ok(_stream) => {
                    log::info!("auto-record gate: {} stream started", source);
                    // Periodically re-resolve availability and callback health;
                    // a disconnected stream must be dropped and reopened.
                    loop {
                        match stop_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        }
                        let last=if source=="mic"{LAST_PROBE_MIC.load(Ordering::SeqCst)}else{LAST_PROBE_SYS.load(Ordering::SeqCst)};
                        let current=if source=="mic"{crate::audio::recording_commands::resolve_default_mic()}else{crate::audio::recording_commands::resolve_default_system()}.map(|d|d.name.clone());
                        let available=current.is_some();
                        if source!="mic"{SYSTEM_AVAILABLE.store(available,Ordering::SeqCst);}
                        if !available || current!=original || monotonic_ms().saturating_sub(last.max(opened))>PROBE_STALE_MS as u64 {
                            SILENCE_DISCONTINUITY.fetch_add(1,Ordering::SeqCst);
                            CALLBACK_SPEECH.lock().unwrap().clear();
                            break;
                        }
                    }
                }
                Err(e) => {
                    log::warn!("auto-record gate: {} stream unavailable ({}); retrying", source, e);
                    emit_event(&app, "probe-error", serde_json::json!({"source": source, "error": e.to_string()}));
                    match stop_rx.recv_timeout(Duration::from_millis(DEVICE_RETRY_MS)) {
                        Ok(_) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }
        }
        log::info!("auto-record gate: {} worker exited", source);
    }

    fn open_stream<R: Runtime>(
        _app: &AppHandle<R>, // reserved: future config/permission plumbing
        source: &'static str,
        out: UnboundedSender<LevelEvent>,
    ) -> anyhow::Result<cpal::Stream> {
        use cpal::traits::{DeviceTrait, StreamTrait};

        // Resolve the same devices the recording pipeline resolves.
        if source!="mic" { SYSTEM_AVAILABLE.store(crate::audio::recording_commands::resolve_default_system().is_some(),Ordering::SeqCst); }
        let audio_device = match source {
            "mic" => crate::audio::recording_commands::resolve_default_mic(),
            _ => crate::audio::recording_commands::resolve_default_system(),
        }
        .ok_or_else(|| anyhow::anyhow!("no {} device available", source))?;

        let (cpal_device, config) =
            tauri::async_runtime::block_on(crate::audio::get_device_and_config(&audio_device))?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let format = config.sample_format();
        log::info!(
            "auto-record gate: {} device '{}' {}Hz {}ch {:?}",
            source, audio_device.name, sample_rate, channels, format
        );

        let stream = match format {
            cpal::SampleFormat::F32 => {
                let sender = out.clone();
                cpal_device.build_input_stream(
                    &cpal_config(sample_rate, channels),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        send_rms(&sender, source, data, channels)
                    },
                    move |err| log::debug!("auto-record gate: {} stream error: {}", source, err),
                    None,
                )?
            }
            cpal::SampleFormat::I16 => {
                let sender = out.clone();
                cpal_device.build_input_stream(
                    &cpal_config(sample_rate, channels),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s.to_sample()).collect();
                        send_rms(&sender, source, &f32_data, channels);
                    },
                    move |err| log::debug!("auto-record gate: {} stream error: {}", source, err),
                    None,
                )?
            }
            cpal::SampleFormat::U16 => {
                let sender = out.clone();
                cpal_device.build_input_stream(
                    &cpal_config(sample_rate, channels),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s.to_sample()).collect();
                        send_rms(&sender, source, &f32_data, channels);
                    },
                    move |err| log::debug!("auto-record gate: {} stream error: {}", source, err),
                    None,
                )?
            }
            other => return Err(anyhow::anyhow!("unsupported sample format {:?}", other)),
        };
        stream.play()?;
        Ok(stream)
    }
}

fn send_rms(sender: &UnboundedSender<LevelEvent>, source: &'static str, data: &[f32], channels: u16) {
    if data.is_empty() {
        return;
    }
    let mono = crate::audio::audio_processing::audio_to_mono(data, channels.max(1));
    if mono.is_empty() {
        return;
    }
    let sum_sq: f32 = mono.iter().map(|&s| s * s).sum();
    let rms = (sum_sq / mono.len() as f32).sqrt();
    let at_ms = monotonic_ms();
    let mic = LAST_PROBE_MIC.load(Ordering::SeqCst); let sys = LAST_PROBE_SYS.load(Ordering::SeqCst);
    if at_ms.saturating_sub(mic) >= PROBE_STALE_MS as u64 || (!cfg!(target_os = "macos") && SYSTEM_AVAILABLE.load(Ordering::SeqCst) && at_ms.saturating_sub(sys) >= PROBE_STALE_MS as u64) {
        SILENCE_DISCONTINUITY.fetch_add(1, Ordering::SeqCst);
    }
    if source == "mic" { LAST_PROBE_MIC.store(at_ms, Ordering::SeqCst); }
    else { LAST_PROBE_SYS.store(at_ms, Ordering::SeqCst); }
    if rms >= f32::from_bits(LIVE_THRESHOLD.load(Ordering::SeqCst)) {
        LAST_PROBE_SPEECH.store(at_ms, Ordering::SeqCst);
        SILENCE_DISCONTINUITY.fetch_add(1, Ordering::SeqCst);
    }
    if let Ok(mut events)=CALLBACK_SPEECH.try_lock(){
        let source=if source=="mic"{"mic"}else{"system"};
        let latest=events.iter().rev().find(|(s,_,_)|*s==source).map(|(_,t,_)|*t).unwrap_or(0);
        if at_ms.saturating_sub(latest)>=100 {
            while events.front().map_or(false,|(_,t,_)|at_ms.saturating_sub(*t)>START_WINDOW_MS){events.pop_front();}
            if events.len()>=64{events.pop_front();}
            events.push_back((source,at_ms,rms>=f32::from_bits(LIVE_THRESHOLD.load(Ordering::SeqCst))));
        }
    }
    let _ = sender.send(LevelEvent { source, rms, at: Instant::now() });
}

/// Rolling window of above/below-threshold booleans.
struct Debounce {
    events: Vec<(Instant, bool)>,
}

impl Debounce {
    fn new() -> Self {
        Self { events: Vec::new() }
    }

    fn push(&mut self, at: Instant, above: bool) {
        self.events.push((at, above));
    }

    fn speech(&self, window_ms: u64, ratio: f32, now: Instant) -> bool {
        let cutoff = now - Duration::from_millis(window_ms);
        let recent: Vec<bool> = self
            .events
            .iter()
            .filter(|(t, _)| *t >= cutoff)
            .map(|(_, a)| *a)
            .collect();
        if recent.len() < 4 {
            return false;
        }
        let above = recent.iter().filter(|a| **a).count();
        (above as f32 / recent.len() as f32) >= ratio
    }

    fn prune(&mut self, now: Instant) {
        let cutoff = now - Duration::from_millis(SILENCE_STOP_MS * 3);
        self.events.retain(|(t, _)| *t >= cutoff);
    }
}

static SILENCE_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

/// How long both sources have been silent (or ZERO if speech is happening now).
fn silence_duration(mic_speech: bool, sys_speech: bool) -> Duration {
    let mut guard = SILENCE_SINCE.lock().unwrap_or_else(|e| e.into_inner());
    if mic_speech || sys_speech {
        *guard = None;
        Duration::ZERO
    } else {
        let since = guard.get_or_insert_with(Instant::now);
        Instant::now().duration_since(*since)
    }
}

fn default_meeting_title() -> String {
    chrono::Local::now().format("%b %d %H:%M").to_string()
}

/// Human-readable "alive" hint for the periodic gate log line (event recency).
fn mic_alive_display(d: &Debounce) -> &'static str {
    if d.events.is_empty() {
        "no-events"
    } else {
        "ok"
    }
}

async fn stop_gate_recording<R: Runtime>(app: &AppHandle<R>, stop_config_epoch: u64) {
    let _trigger_guard = super::server::TRIGGER_LOCK.lock().await;
    let save_path = crate::audio::recording_commands::get_meeting_folder_path()
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let args = crate::audio::recording_commands::RecordingArgs { save_path };
    let generation = STATE
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|s| s.native_generation)
        .unwrap_or(0);
    match crate::audio::recording_commands::stop_recording_if_generation(
        app.clone(),
        args,
        generation,
        move || {
            STATE
                .session
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map_or(false, |s| {
                    s.trigger == "audio-gate" && s.native_generation == generation && stop_config_epoch == super::GATE_CONFIG_EPOCH.load(Ordering::SeqCst) && live_silence_eligible()
                })
        },
    )
    .await
    {
        Ok(true) => {
            *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = None;
            emit_event(app, "auto-record-stopped", serde_json::json!({"trigger": "audio-gate-silence"}));
            super::emit_post_processing_complete(app);
        }
        Ok(false) => {}
        Err(e) => log::error!("auto-record gate: stop failed: {}", e),
    }
}

pub async fn run<R: Runtime>(app: AppHandle<R>) {
    // Let the device subsystem settle at boot.
    tokio::time::sleep(Duration::from_secs(5)).await;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LevelEvent>();
    let _gate_mic = ProbeThread::start(app.clone(), "mic", tx.clone());
    #[cfg(not(target_os = "macos"))]
    let _gate_sys = Some(ProbeThread::start(app.clone(), "system", tx.clone()));
    #[cfg(target_os = "macos")]
    let _gate_sys: Option<ProbeThread> = None;

    // Explicit stop stays suppressed through continued speech. Rearm only
    // after 60s of healthy observed silence; missing probes cannot rearm.
    let mut cleanup_retry_at = Instant::now();
    let mut rearm_discontinuity = 0;
    let mut rearm = crate::audio::lifecycle_policy::GateRearm::default();
    let mut mic = Debounce::new();
    let mut sys = Debounce::new();
    let mut last_event_mic: Option<Instant> = None;
    let mut last_event_sys: Option<Instant> = None;
    let mut last_cfg_check = Instant::now() - Duration::from_secs(999);
    let (mut cached_cfg, mut cached_epoch) = super::gate_snapshot(&app).await;
    LIVE_THRESHOLD.store(cached_cfg.speech_threshold.to_bits(), Ordering::SeqCst);

    loop {
        match tokio::time::timeout(Duration::from_millis(PROBE_INTERVAL_MS), rx.recv()).await {
            Ok(Some(ev)) => {
                let above = ev.rms >= cached_cfg.speech_threshold;
                if ev.source == "mic" {
                    mic.push(ev.at, above);
                    last_event_mic = Some(ev.at);
                } else {
                    sys.push(ev.at, above);
                    last_event_sys = Some(ev.at);
                }
            }
            Ok(None) => {
                log::warn!("auto-record gate: level channel closed; monitor stopping");
                break;
            }
            Err(_) => {}
        }

        LIVE_THRESHOLD.store(cached_cfg.speech_threshold.to_bits(), Ordering::SeqCst);
        let now = Instant::now();
        if now.duration_since(last_cfg_check) > Duration::from_secs(5) || cached_epoch != super::GATE_CONFIG_EPOCH.load(Ordering::SeqCst) {
            let (snapshot, epoch) = super::gate_snapshot(&app).await;
            let changed = cached_epoch != epoch;
            cached_cfg = snapshot; cached_epoch = epoch;
            LIVE_THRESHOLD.store(cached_cfg.speech_threshold.to_bits(), Ordering::SeqCst);
            if changed {
                mic.events.clear(); sys.events.clear();
                LAST_PROBE_SPEECH.store(0, Ordering::SeqCst);
                CALLBACK_SPEECH.lock().unwrap().clear();
                *HEALTHY_SILENCE.lock().unwrap() = None;
        SILENCE_DISCONTINUITY.fetch_add(1, Ordering::SeqCst);
            }
            last_cfg_check = now;
            mic.prune(now);
            sys.prune(now);
            super::debug::debug_log(
                &app,
                "gate",
                "info",
                format!(
                    "probe status: mode={} enabled={} mic={} sys={} threshold={:.3} (mic/sys: ok=events flowing, no-events=probe dead)",
                    cached_cfg.mode,
                    cached_cfg.enabled,
                    mic_alive_display(&mic),
                    mic_alive_display(&sys),
                    cached_cfg.speech_threshold
                ),
            );
        }

        // A superseded gate with failed cleanup is an error owner, not a live
        // speech session. Retry independently of mode/probes/enablement.
        let cleanup = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            .filter(|s| s.trigger == "audio-gate" && s.cleanup_error.is_some()).cloned();
        if let Some(session) = cleanup {
            let _trigger_guard = super::server::TRIGGER_LOCK.lock().await;
            let still_owned = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                .map_or(false, |s| s.trigger == "audio-gate" && s.native_generation == session.native_generation && s.cleanup_error.is_some());
            if still_owned && Instant::now() >= cleanup_retry_at {
                cleanup_retry_at = Instant::now() + Duration::from_secs(30);
                let _ = super::cleanup_superseded(&app, session).await;
            }
            continue;
        }

        if !cached_cfg.enabled {
            // Disabled monitoring is not evidence of continuous healthy silence.
            rearm.allows(crate::audio::recording_commands::stop_epoch(),
                crate::audio::recording_commands::stop_pending(), false, false,
                monotonic_ms(), SILENCE_STOP_MS);
            super::debug::sync_file_enabled(cached_cfg.debug_log_enabled);
            continue; // keep probes warm so re-enabling reacts instantly
        }
        super::debug::sync_file_enabled(cached_cfg.debug_log_enabled);

        let mic_speech = mic.speech(START_WINDOW_MS, START_RATIO, now);
        let sys_speech = sys.speech(START_WINDOW_MS, START_RATIO, now);
        let audio_speech = mic_speech || sys_speech;
        let recording = crate::audio::recording_commands::is_recording().await;

        // Extension deadman: a fresh heartbeat means the extension path owns triggering.
        let hb = STATE.heartbeat.load(Ordering::SeqCst);
        let ext_fresh = hb > 0 && now_ms().saturating_sub(hb) < 10_000;

        // Probes alive? (no events for PROBE_STALE_MS => dead => fail-safe behavior)
        let mic_alive = last_event_mic.map(|t| now.duration_since(t).as_millis() < PROBE_STALE_MS).unwrap_or(false);
        let sys_alive = last_event_sys.map(|t| now.duration_since(t).as_millis() < PROBE_STALE_MS).unwrap_or(false);
        let probes_report = mic_speech || sys_speech || mic_alive || sys_alive;

        let start_epoch = crate::audio::recording_commands::stop_epoch();
        let continuous_silence = live_silence_eligible(); // sample continuously, not only on stop attempts
        let callback_speech = monotonic_ms().saturating_sub(LAST_PROBE_SPEECH.load(Ordering::SeqCst)) < PROBE_INTERVAL_MS;
        let discontinuity = SILENCE_DISCONTINUITY.load(Ordering::SeqCst);
        if discontinuity != rearm_discontinuity { rearm.interrupt_quiet(); rearm_discontinuity = discontinuity; }
        let gate_allowed = rearm.allows(
            start_epoch,
            crate::audio::recording_commands::stop_pending(),
            callback_speech,
            mic_alive && (cfg!(target_os = "macos") || !SYSTEM_AVAILABLE.load(Ordering::SeqCst) || sys_alive),
            monotonic_ms(),
            SILENCE_STOP_MS,
        );
        // Reset silence duration on speech even while the gate is suppressed.
        let silence = silence_duration(mic_speech, sys_speech);
        match cached_cfg.mode.as_str() {
            "audio" | "hybrid" => {
                let gate_owns = !(cached_cfg.mode == "hybrid" && ext_fresh);

                if !recording
                    && gate_allowed
                    && gate_owns
                    && probes_report
                    && audio_speech
                    && cached_cfg.auto_start_enabled
                {
                    log::info!("auto-record gate: sustained audio detected; starting recording");
                    super::debug::debug_log(
                        &app,
                        "gate",
                        "info",
                        format!(
                            "sustained audio detected (mic={} sys={}); starting recording",
                            mic_speech, sys_speech
                        ),
                    );
                    emit_event(
                        &app,
                        "gate-trigger-start",
                        serde_json::json!({"mic": mic_speech, "system": sys_speech}),
                    );
                    let config_epoch = cached_epoch;
                    let _trigger_guard = super::server::TRIGGER_LOCK.lock().await;
                    let (current_cfg, current_epoch) = super::gate_snapshot(&app).await;
                    if current_epoch != config_epoch { continue; }
                    if !current_cfg.enabled || !current_cfg.auto_start_enabled || !["audio", "hybrid"].contains(&current_cfg.mode.as_str()) { continue; }
                    // Status observed before acquiring TRIGGER_LOCK may be stale.
                    if crate::audio::recording_commands::is_recording().await
                        || !crate::audio::recording_commands::automatic_start_allowed(start_epoch)
                        || monotonic_ms().saturating_sub(LAST_PROBE_SPEECH.load(Ordering::SeqCst)) > START_WINDOW_MS
                        || monotonic_ms().saturating_sub(LAST_PROBE_MIC.load(Ordering::SeqCst)) > PROBE_STALE_MS as u64
                        || (cached_cfg.mode == "hybrid" && now_ms().saturating_sub(STATE.heartbeat.load(Ordering::SeqCst)) < 10_000)
                    { continue; }
                    let session = SessionMeta {
                        meeting_name: format!("Auto-detected {}", default_meeting_title()),
                        platform: "audio".to_string(),
                        trigger: "audio-gate".to_string(),
                        native_generation: 0,
                        cleanup_error: None,
                        request_id: None,
                        started_at_ms: now_ms(),
                        last_heartbeat_ms: now_ms(),
                    };
                    let name = session.meeting_name.clone();
                    let recovery_receipt = std::sync::Arc::new(std::sync::Mutex::new(None));
                    match crate::audio::recording_commands::start_gate_recording(
                        app.clone(),
                        name.clone(),
                        start_epoch,
                        move || fresh_sustained_speech() && config_epoch == super::GATE_CONFIG_EPOCH.load(Ordering::SeqCst)
                            && monotonic_ms().saturating_sub(LAST_PROBE_SPEECH.load(Ordering::SeqCst)) <= START_WINDOW_MS
                            && LAST_PROBE_MIC.load(Ordering::SeqCst) > 0 && monotonic_ms().saturating_sub(LAST_PROBE_MIC.load(Ordering::SeqCst)) < PROBE_STALE_MS as u64
                            && (cfg!(target_os = "macos") || !SYSTEM_AVAILABLE.load(Ordering::SeqCst) || (LAST_PROBE_SYS.load(Ordering::SeqCst) > 0 && monotonic_ms().saturating_sub(LAST_PROBE_SYS.load(Ordering::SeqCst)) < PROBE_STALE_MS as u64))
                            && (current_cfg.mode != "hybrid" || (!super::server::EXTENSION_START_PENDING.any() && now_ms().saturating_sub(STATE.heartbeat.load(Ordering::SeqCst)) >= 10_000)),
                        recovery_receipt.clone(),
                    )
                    .await
                    {
                        Ok(generation) => {
                            if generation != crate::audio::recording_commands::recording_generation()
                        || !crate::audio::recording_commands::is_recording().await
                        || start_epoch != crate::audio::recording_commands::stop_epoch()
                                || crate::audio::recording_commands::stop_pending()
                                || config_epoch != super::GATE_CONFIG_EPOCH.load(Ordering::SeqCst)
                            {
                                let mut cancelled = session;
                                cancelled.native_generation = generation;
                                if let Err(e) = super::cleanup_superseded(&app, cancelled).await {
                                    log::error!("auto-record gate: superseded cleanup requires retry: {}", e);
                                }
                                continue;
                            }
                            let mut session = session;
                            session.native_generation = generation;
                            *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
                            super::debug::debug_log(
                                &app,
                                "gate",
                                "info",
                                "gate-started recording active".to_string(),
                            );
                            super::notify::notify(
                                &app,
                                "Recording started (audio detected)",
                                &format!("{} — no browser trigger seen; using the audio gate", name),
                            );
                            emit_event(&app, "auto-record-started", serde_json::json!({"trigger": "audio-gate"}))
                        }
                        Err(e) => {
                            if let Some(generation) = *recovery_receipt.lock().unwrap() {
                                let mut failed = session;
                                failed.native_generation = generation;
                                failed.cleanup_error = Some(e.clone());
                                *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(failed);
                            }
                            log::error!("auto-record gate: start failed: {}", e);
                            super::debug::debug_log(&app, "gate", "error", format!("gate start failed: {}", e));
                            super::notify::notify(
                                &app,
                                "Auto-record failed to start",
                                &format!("Audio gate trigger — {}", e),
                            );
                        }
                    }
                } else if recording && gate_owns && !audio_speech {
                    // Only gate-stops gate-starts; fail-safe if probes look dead.
                    let gate_started = STATE
                        .session
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .map(|s| s.trigger == "audio-gate")
                        .unwrap_or(false);
                    if gate_started && probes_report {
                        if silence > Duration::from_millis(SILENCE_STOP_MS) {
                            log::info!("auto-record gate: sustained silence; stopping gate-started recording");
                            super::debug::debug_log(
                                &app,
                                "gate",
                                "info",
                                format!("sustained silence {}s; stopping gate-started recording", SILENCE_STOP_MS / 1000),
                            );
                            stop_gate_recording(&app, cached_epoch).await;
                        }
                    }
                }
            }
            _ => {} // "extension": gate observes only
        }
    }
}