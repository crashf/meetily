// src/auto_record/notify.rs
// Pund-IT fork addition: native notifications for auto-record lifecycle events. PUN-801.
//
// Uses tauri_plugin_notification directly (already initialized in lib.rs run() with
// default consent + permission requested at boot). Fire-and-forget: notification
// failures must never affect the recording path.
//
// Config plumbing: load_config() runs async and is called by the gate/watchdog every
// few seconds; it mirrors the user-facing toggles into atomics via sync_flags(), so
// the sync notify() call sites never touch the store or block_on.
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Runtime;
use tauri_plugin_notification::NotificationExt;

static NOTIFY_ENABLED: AtomicBool = AtomicBool::new(true);
static THROTTLE: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Called from load_config() after (re)reading the config.
pub fn sync_flags(notify_enabled: bool) {
    NOTIFY_ENABLED.store(notify_enabled, Ordering::Relaxed);
}

/// Send a native notification (respects cfg.notify_enabled; fire-and-forget).
pub fn notify<R: Runtime>(app: &tauri::AppHandle<R>, title: &str, body: &str) {
    if !NOTIFY_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    send(app, title, body);
}

/// Send a notification bypassing the user setting (used only for the Settings test button,
/// so Wayne can verify the plumbing even with notifications toggled off).
pub fn send<R: Runtime>(app: &tauri::AppHandle<R>, title: &str, body: &str) {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        app.notification().builder().title(title).body(body).show()
    }));
    match res {
        Ok(Ok(())) => log::info!(target: "auto_record", "notification shown: {}", title),
        Ok(Err(e)) => log::warn!(target: "auto_record", "notification failed: {}", e),
        Err(_) => log::warn!(target: "auto_record", "notification panicked"),
    }
}

/// Same as notify() but rate-limits repeated alerts of the same key, so a flapping
/// failure can't spam notifications (e.g. bind-fail retries every 30s, heartbeats
/// failing twice a minute during an outage).
pub fn notify_throttled<R: Runtime>(
    app: &tauri::AppHandle<R>,
    key: &str,
    min_interval_ms: u64,
    title: &str,
    body: &str,
) {
    let mut guard = match THROTTLE.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let now = crate::auto_record::now_ms();
    if let Some(last) = guard.get(key) {
        if now.saturating_sub(*last) < min_interval_ms {
            return;
        }
    }
    guard.insert(key.to_string(), now);
    drop(guard);
    send(app, title, body);
}