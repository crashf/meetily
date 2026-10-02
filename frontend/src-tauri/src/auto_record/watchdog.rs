// src/auto_record/watchdog.rs
// Keeps the trigger server alive: respawns on shutdown signal (config change),
// retries after bind failures (port busy at boot, e.g. single-instance overlap).
use super::server::{self, ServerExit};
use super::load_config;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Runtime};

const RECHECK_INTERVAL_MS: u64 = 30_000;

/// If an extension-started recording's heartbeat goes silent for HEARTBEAT_DEADMAN_MS
/// (browser closed/crashed mid-meeting), stop the orphaned recording. Long interval:
/// false-stops destroy transcript data, false-continues only record silence.
const HEARTBEAT_DEADMAN_MS: u64 = 5 * 60_000;

pub async fn heartbeat_monitor<R: Runtime>(app: AppHandle<R>) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let session = super::STATE.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(session) = session else { continue };
        if session.trigger != "extension" {
            continue;
        }
        let rec = crate::audio::recording_commands::is_recording().await;
        if !rec {
            continue;
        }
        let stale_ms = super::now_ms().saturating_sub(session.last_heartbeat_ms);
        if stale_ms > HEARTBEAT_DEADMAN_MS {
            log::warn!(
                "auto-record: extension heartbeat silent {}ms; stopping orphaned recording '{}'",
                stale_ms, session.meeting_name
            );
            super::debug::debug_log(
                &app,
                "watchdog",
                "warn",
                format!(
                    "extension heartbeat silent {}ms (last beat older than {} min); stopping orphaned recording '{}'",
                    stale_ms,
                    HEARTBEAT_DEADMAN_MS / 60_000,
                    session.meeting_name
                ),
            );
            super::notify::notify(
                &app,
                "Recording stopped (browser silent)",
                &format!("No heartbeat from the meeting for {} min — saved '{}'. If the meeting was still live, the extension lost connection.", HEARTBEAT_DEADMAN_MS / 60_000, session.meeting_name),
            );
            let save_path = crate::audio::recording_commands::get_meeting_folder_path()
                .await
                .unwrap_or(None)
                .unwrap_or_default();
            let args = crate::audio::recording_commands::RecordingArgs { save_path };
            match crate::audio::recording_commands::stop_recording(app.clone(), args).await {
                Ok(()) => {
                    *super::STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    super::emit_event(&app, "auto-record-stopped",
                        serde_json::json!({"reason": "heartbeat-deadman", "meeting_name": session.meeting_name}));
                    super::emit_post_processing_complete(&app);
                }
                Err(e) => log::error!("auto-record: deadman stop failed: {}", e),
            }
        }
    }
}

pub async fn run<R: Runtime>(app: AppHandle<R>) {
    loop {
        let cfg = load_config(&app).await;
        if cfg.enabled {
            match server::run(app.clone()).await {
                ServerExit::ShutdownSignal => {
                    // Intentional stop (config change from settings UI).
                    // Brief pause, then re-read config; watchdog respawns with new values.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                ServerExit::BindFailed(e) => {
                    log::error!(
                        "auto-record watchdog: trigger server failed to bind ({}); retrying in {}s",
                        e, 10
                    );
                    // Inline bind retries inside server::run handle the short races
                    // (config-save restarts); this backoff covers real conflicts
                    // (another app squatting the port) — 10s, not 30s.
                    tokio::time::sleep(Duration::from_millis(10_000)).await;
                    super::debug::debug_log(&app, "watchdog", "warn", format!("bind failed ({}); watchdog retry in 10s", e));
                }
                ServerExit::DisabledAtBoot => {
                    // Disabled in settings — sleep, then re-check in case it's re-enabled.
                    tokio::time::sleep(Duration::from_millis(RECHECK_INTERVAL_MS)).await;
                }
            }
        } else {
            tokio::time::sleep(Duration::from_millis(RECHECK_INTERVAL_MS)).await;
            // Make sure a stale "running" flag can't wedge the status UI.
            if !cfg.enabled {
                super::STATE.server_running.store(false, Ordering::SeqCst);
            }
        }
    }
}