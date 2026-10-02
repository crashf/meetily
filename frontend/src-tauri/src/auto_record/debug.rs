// src/auto_record/debug.rs
// Pund-IT fork addition: always-on diagnostic ring + optional file debug log.
// Backs the Settings "Debug & diagnostics" panel. PUN-801.
//
// Design:
// - Ring buffer (500 entries) is ALWAYS on — zero-config post-mortems, negligible cost.
// - File logging is opt-in (`debug_log_enabled` in auto_record.json); appends to
//   app_data_dir/auto_record_debug.log, rotated at 1 MB (one .old generation).
// - The file toggle is mirrored into an AtomicBool by load_config() (single source of
//   truth, called every few seconds by the gate/watchdog), so log lines never touch
//   the store and never block_on from a runtime worker.
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

pub const RING_CAP: usize = 500;
pub const FILE_ROTATE_BYTES: u64 = 1_000_000;
pub const DEBUG_LOG_FILE: &str = "auto_record_debug.log";

#[derive(Debug, Clone, Serialize)]
pub struct DebugEntry {
    /// ms since UNIX epoch
    pub at: u64,
    /// "server" | "gate" | "watchdog" | "trigger" | "ui"
    pub source: String,
    /// "info" | "warn" | "error"
    pub level: String,
    pub message: String,
}

static RING: Lazy<Mutex<Vec<DebugEntry>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Mirrors `config.debug_log_enabled`; load_config() keeps this in sync.
static FILE_ENABLED: AtomicBool = AtomicBool::new(false);

/// Called from load_config() after (re)reading the config.
pub fn sync_file_enabled(enabled: bool) {
    FILE_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Ring buffer push + best-effort file append (file only when debug log enabled).
/// Never panics, never blocks: a dropped log line must not kill a trigger.
pub fn debug_log<R: Runtime>(app: &AppHandle<R>, source: &str, level: &str, message: String) {
    let entry = DebugEntry {
        at: super::now_ms(),
        source: source.to_string(),
        level: level.to_string(),
        message,
    };
    // Mirror into the standard log too (app console, tracing views).
    match level {
        "error" => log::error!(target: "auto_record", "[{}] {}", source, entry.message),
        "warn" => log::warn!(target: "auto_record", "[{}] {}", source, entry.message),
        _ => log::info!(target: "auto_record", "[{}] {}", source, entry.message),
    }

    if let Ok(mut ring) = RING.lock() {
        ring.push(entry.clone());
        let over = ring.len().saturating_sub(RING_CAP);
        if over > 0 {
            ring.drain(..over);
        }
    }

    if FILE_ENABLED.load(Ordering::Relaxed) {
        append_file(app, &entry);
    }
}

fn append_file<R: Runtime>(app: &AppHandle<R>, entry: &DebugEntry) {
    let Some(dir) = app.path().app_data_dir().ok() else { return };
    let path = dir.join(DEBUG_LOG_FILE);
    // Rotate when oversized: keep one .old generation.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= FILE_ROTATE_BYTES {
            let old = dir.join("auto_record_debug.old.log");
            let _ = std::fs::rename(&path, old);
        }
    }
    let line = format!(
        "{} [{:>5}] {:>8} {}\n",
        chrono::DateTime::from_timestamp_millis(entry.at as i64)
            .map(|dt| dt
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string())
            .unwrap_or_else(|| entry.at.to_string()),
        entry.level,
        entry.source,
        entry.message
    );
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
    {
        log::warn!(target: "auto_record", "debug file write failed: {}", e);
    }
}

/// Diagnostics snapshot for the Settings debug panel.
#[tauri::command]
pub async fn auto_record_get_diagnostics<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let cfg = super::load_config(&app).await;
    let ring = RING.lock().map_err(|e| e.to_string())?.clone();
    let hb = super::STATE.heartbeat.load(std::sync::atomic::Ordering::SeqCst);
    let last_heartbeat_ms_ago = if hb > 0 {
        Some(super::now_ms().saturating_sub(hb))
    } else {
        None
    };
    Ok(serde_json::json!({
        "config": {
            "enabled": cfg.enabled,
            "mode": cfg.mode,
            "port": cfg.port,
            "tokenPrefix": cfg.token.chars().take(8).collect::<String>(),
            "notifyEnabled": cfg.notify_enabled,
            "debugLogEnabled": cfg.debug_log_enabled,
        },
        "serverRunning": super::STATE.server_running.load(std::sync::atomic::Ordering::SeqCst),
        "recording": crate::audio::recording_commands::is_recording().await,
        "lastHeartbeatMsAgo": last_heartbeat_ms_ago,
        "logEntries": ring,
    }))
}

/// In-app test notification (Settings button).
#[tauri::command]
pub async fn auto_record_test_notification<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    crate::auto_record::notify::notify(
        &app,
        "Meetily notification test",
        "If you can see this, auto-record notifications work.",
    );
    debug_log(&app, "ui", "info", "Test notification requested from settings".to_string());
    Ok(serde_json::json!({"ok": true}))
}

/// Clear the ring buffer (Settings button). File log is left alone.
#[tauri::command]
pub async fn auto_record_clear_diagnostics<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    RING.lock().map_err(|e| e.to_string())?.clear();
    debug_log(&app, "ui", "info", "Diagnostics cleared".to_string());
    Ok(serde_json::json!({"ok": true}))
}

/// Manual trigger-server restart (Settings button): signal shutdown; the watchdog
/// respawns within ~1s. With inline bind retries this is a fast, reliable recycle.
#[tauri::command]
pub async fn auto_record_restart_server<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    debug_log(&app, "ui", "info", "Manual trigger-server restart requested".to_string());
    super::server::signal_shutdown();
    Ok(serde_json::json!({"ok": true}))
}