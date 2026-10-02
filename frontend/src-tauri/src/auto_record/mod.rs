// src/auto_record/mod.rs
// Pund-IT fork addition: browser-triggered auto-record (Chrome extension -> local HTTP -> recording)
// Design: Wayne 2026-10-02 — extension is primary trigger; audio-onset gate is fallback.
use once_cell::sync::Lazy;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;

pub mod audio_gate;
pub mod debug;
pub mod notify;
pub mod server;
pub mod watchdog;

pub const STORE_FILE: &str = "auto_record.json";
pub const DEFAULT_PORT: u16 = 7788;

/// Feature configuration, persisted in the tauri store like RecordingPreferences.
/// Every field has a serde default so partial/stored-older configs deserialize cleanly.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AutoRecordConfig {
    #[serde(default)]
    pub enabled: bool,
    /// "extension" | "audio" | "hybrid" (extension first, audio gate as fallback trigger)
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Local loopback port for the trigger endpoint
    #[serde(default = "default_port")]
    pub port: u16,
    /// Bearer token the extension must send (regenerated on first run)
    #[serde(default)]
    pub token: String,
    /// Audio gate: RMS threshold above which audio counts as speech (0.0-1.0)
    #[serde(default = "default_speech_threshold")]
    pub speech_threshold: f32,
    #[serde(default = "default_true")]
    pub auto_start_enabled: bool,
    /// Native notifications for auto-record events (started/stopped/errors). PUN-801.
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// Append auto-record diagnostics to app_data_dir/auto_record_debug.log. PUN-801.
    #[serde(default)]
    pub debug_log_enabled: bool,
}

fn default_mode() -> String {
    "hybrid".to_string()
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_speech_threshold() -> f32 {
    0.06
}
fn default_true() -> bool {
    true
}

impl Default for AutoRecordConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: default_mode(),
            port: DEFAULT_PORT,
            token: String::new(),
            speech_threshold: default_speech_threshold(),
            auto_start_enabled: true,
            notify_enabled: true,
            debug_log_enabled: false,
        }
    }
}

impl AutoRecordConfig {
    pub fn ensure_token(&mut self) {
        if self.token.is_empty() {
            let mut bytes = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut bytes);
            self.token = hex_encode(&bytes);
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Snapshot of the currently-armed/active auto-record session (set by the extension path).
#[derive(Debug, Serialize, Clone)]
pub struct SessionMeta {
    pub meeting_name: String,
    pub platform: String,
    pub trigger: String,
    pub started_at_ms: u64,
    pub last_heartbeat_ms: u64,
}

pub struct AutoRecordState {
    pub session: Mutex<Option<SessionMeta>>,
    pub server_running: AtomicBool,
    pub heartbeat: AtomicU64,
    pub recording_active: AtomicBool,
}

pub static STATE: Lazy<AutoRecordState> = Lazy::new(|| AutoRecordState {
    session: Mutex::new(None),
    server_running: AtomicBool::new(false),
    heartbeat: AtomicU64::new(0),
    recording_active: AtomicBool::new(false),
});

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub async fn load_config<R: Runtime>(app: &AppHandle<R>) -> AutoRecordConfig {
    let had_stored_config = match app.store(STORE_FILE) {
        Ok(store) => store.get("config").is_some(),
        Err(_) => false,
    };
    let mut cfg = match app.store(STORE_FILE) {
        Ok(store) => match store.get("config") {
            Some(value) => serde_json::from_value(value.clone()).unwrap_or_default(),
            None => {
                log::info!("auto-record config absent; using defaults");
                AutoRecordConfig::default()
            }
        },
        Err(e) => {
            log::warn!("auto-record store unavailable: {}", e);
            AutoRecordConfig::default()
        }
    };
    let generated = cfg.token.is_empty();
    cfg.ensure_token();
    // Persist immediately on first run so the extension can pair with the
    // token from disk (settings UI or the store file) without a save action.
    if generated || !had_stored_config {
        save_config(app, &cfg).await;
    }
    // Keep the debug-log file toggle in sync with the store (cheap atomic mirror).
    debug::sync_file_enabled(cfg.debug_log_enabled);
    notify::sync_flags(cfg.notify_enabled);
    cfg
}

pub async fn save_config<R: Runtime>(app: &AppHandle<R>, cfg: &AutoRecordConfig) {
    let Ok(store) = app.store(STORE_FILE) else {
        log::error!("auto-record store unavailable; config not saved");
        return;
    };
    // NOTE: store.set() returns () in tauri-plugin-store 2.x; store.save() is the fallible flush.
    store.set("config", serde_json::to_value(cfg).unwrap_or_default());
    if let Err(e) = store.save() {
        log::error!("auto-record store flush failed: {}", e);
    }
}

/// Emit a status event so the UI/tray can surface auto-record activity.
pub fn emit_event<R: Runtime>(app: &AppHandle<R>, kind: &str, payload: serde_json::Value) {
    let _ = app.emit(
        "auto-record-event",
        serde_json::json!({
            "kind": kind,
            "at": now_ms(),
            "data": payload,
        }),
    );
}

#[tauri::command]
pub async fn auto_record_get_status<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let cfg = load_config(&app).await;
    let session = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let rec = crate::audio::recording_commands::is_recording().await;
    let hb = STATE.heartbeat.load(Ordering::SeqCst);
    Ok(serde_json::json!({
        "enabled": cfg.enabled,
        "mode": cfg.mode,
        "port": cfg.port,
        "token": cfg.token,
        "speechThreshold": cfg.speech_threshold,
        "notifyEnabled": cfg.notify_enabled,
        "debugLogEnabled": cfg.debug_log_enabled,
        "serverRunning": STATE.server_running.load(Ordering::SeqCst),
        "recording": rec,
        "session": session,
        "lastHeartbeatMsAgo": if hb > 0 { Some(now_ms().saturating_sub(hb)) } else { None },
    }))
}

/// Merge a partial config patch, persist, and restart the trigger server when needed.
#[tauri::command]
pub async fn auto_record_set_config<R: Runtime>(
    app: AppHandle<R>,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut cfg = load_config(&app).await;
    if let Some(obj) = patch.as_object() {
        let cur = serde_json::to_value(&cfg).unwrap_or(serde_json::json!({}));
        let mut merged = cur;
        if let Some(m) = merged.as_object_mut() {
            for (k, v) in obj {
                m.insert(k.clone(), v.clone());
            }
        }
        cfg = serde_json::from_value(merged).map_err(|e| format!("invalid auto-record config: {}", e))?;
    }
    cfg.ensure_token();
    save_config(&app, &cfg).await;

    // Restart server so port/token changes apply immediately.
    if STATE.server_running.load(Ordering::SeqCst) {
        server::signal_shutdown();
        // give the listener a beat to exit, then watchdog respawns with new config
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    Ok(serde_json::json!({"ok": true}))
}

/// Entry point called from lib.rs setup(): boots watchdog + trigger server + audio gate.
pub fn spawn_services<R: Runtime + 'static>(app: AppHandle<R>) {
    let app_watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        watchdog::run(app_watchdog).await;
    });
    let app_gate = app.clone();
    tauri::async_runtime::spawn(async move {
        audio_gate::run(app_gate).await;
    });
    let app_hb = app.clone();
    tauri::async_runtime::spawn(async move {
        watchdog::heartbeat_monitor(app_hb).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let c = AutoRecordConfig::default();
        assert!(c.enabled, "auto-record should default to enabled");
        assert_eq!(c.mode, "hybrid");
        assert_eq!(c.port, DEFAULT_PORT);
        assert!(c.token.is_empty(), "token generated later, not in Default");
        assert!(c.speech_threshold > 0.0 && c.speech_threshold < 1.0);
        assert!(c.auto_start_enabled);
        assert!(c.notify_enabled, "notifications should default on (PUN-801)");
        assert!(!c.debug_log_enabled, "debug file log should default off (privacy)");
    }

    #[test]
    fn partial_stored_config_fills_defaults() {
        // Simulates an older store file missing newer fields.
        let v: serde_json::Value =
            serde_json::from_str(r#"{"enabled": false, "mode": "extension"}"#).unwrap();
        let c: AutoRecordConfig = serde_json::from_value(v).expect("partial config must parse");
        assert!(!c.enabled);
        assert_eq!(c.mode, "extension");
        assert_eq!(c.port, DEFAULT_PORT);
        assert_eq!(c.speech_threshold, 0.06);
    }

    #[test]
    fn ensure_token_is_hex_and_stable() {
        let mut c = AutoRecordConfig::default();
        assert!(c.token.is_empty());
        c.ensure_token();
        assert_eq!(c.token.len(), 32);
        assert!(c.token.chars().all(|ch| ch.is_ascii_hexdigit()));
        let first = c.token.clone();
        c.ensure_token();
        assert_eq!(c.token, first, "ensure_token must not regenerate");
    }

    #[test]
    fn full_config_roundtrip() {
        let mut c = AutoRecordConfig {
            speech_threshold: 0.11,
            ..Default::default()
        };
        c.ensure_token();
        let v = serde_json::to_value(&c).unwrap();
        let c2: AutoRecordConfig = serde_json::from_value(v).unwrap();
        assert_eq!(c2.speech_threshold, 0.11);
        assert_eq!(c2.token, c.token);
        assert_eq!(c2.port, c.port);
    }
}