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
            match Self::open_stream(&app, source, out.clone()) {
                Ok(_stream) => {
                    log::info!("auto-record gate: {} stream started", source);
                    // Park until a stop request or channel close; dropping `stream` stops capture.
                    match stop_rx.recv() {
                        Ok(_) => break,
                        Err(_) => break,
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
                    move |data: &[f32], _: &cpal::InputCallbackInfo| send_rms(&sender, source, data, channels),
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

async fn stop_gate_recording<R: Runtime>(app: &AppHandle<R>) {
    let save_path = crate::audio::recording_commands::get_meeting_folder_path()
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let args = crate::audio::recording_commands::RecordingArgs { save_path };
    match crate::audio::recording_commands::stop_recording(app.clone(), args).await {
        Ok(()) => {
            *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = None;
            emit_event(app, "auto-record-stopped", serde_json::json!({"trigger": "audio-gate-silence"}));
        }
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

    let mut mic = Debounce::new();
    let mut sys = Debounce::new();
    let mut last_event_mic: Option<Instant> = None;
    let mut last_event_sys: Option<Instant> = None;
    let mut last_cfg_check = Instant::now() - Duration::from_secs(999);
    let mut cached_cfg = load_config(&app).await;

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

        let now = Instant::now();
        if now.duration_since(last_cfg_check) > Duration::from_secs(5) {
            cached_cfg = load_config(&app).await;
            last_cfg_check = now;
            mic.prune(now);
            sys.prune(now);
        }

        if !cached_cfg.enabled {
            continue; // keep probes warm so re-enabling reacts instantly
        }

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

        match cached_cfg.mode.as_str() {
            "audio" | "hybrid" => {
                let gate_owns = !(cached_cfg.mode == "hybrid" && ext_fresh);

                if !recording && gate_owns && probes_report && audio_speech && cached_cfg.auto_start_enabled {
                    log::info!("auto-record gate: sustained audio detected; starting recording");
                    emit_event(&app, "gate-trigger-start", serde_json::json!({"mic": mic_speech, "system": sys_speech}));
                    let session = SessionMeta {
                        meeting_name: format!("Auto-detected {}", default_meeting_title()),
                        platform: "audio".to_string(),
                        trigger: "audio-gate".to_string(),
                        started_at_ms: now_ms(),
                        last_heartbeat_ms: now_ms(),
                    };
                    let name = session.meeting_name.clone();
                    *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
                    match crate::audio::recording_commands::start_recording_with_devices_and_meeting(
                        app.clone(), None, None, Some(name),
                    ).await {
                        Ok(()) => emit_event(&app, "auto-record-started", serde_json::json!({"trigger": "audio-gate"})),
                        Err(e) => {
                            log::error!("auto-record gate: start failed: {}", e);
                            *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
                        if silence_duration(mic_speech, sys_speech) > Duration::from_millis(SILENCE_STOP_MS) {
                            log::info!("auto-record gate: sustained silence; stopping gate-started recording");
                            stop_gate_recording(&app).await;
                        }
                    }
                }
            }
            _ => {} // "extension": gate observes only
        }
    }
}