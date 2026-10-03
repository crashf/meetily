#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use env_logger;

fn main() {
    // Install first so even early startup panics are recorded before Tauri.
    #[cfg(target_os = "windows")]
    app_lib::startup_diagnostic::install();

    std::env::set_var("RUST_LOG", "info");
    env_logger::init();

    #[cfg(target_os = "windows")]
    app_lib::startup_diagnostic::checkpoint("env_logger initialized");

    // Async logger will be initialized lazily when first needed (after Tauri runtime starts)
    log::info!("Starting application...");
    #[cfg(target_os = "windows")]
    app_lib::startup_diagnostic::checkpoint("calling app_lib::run");
    app_lib::run();
}

#[cfg(target_os = "windows")]
pub(crate) mod startup_diagnostic {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        panic,
        path::PathBuf,
        sync::Mutex,
    };

    static WRITE_LOCK: Mutex<()> = Mutex::new(());

    fn log_path() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|root| {
            PathBuf::from(root).join("meetily").join("startup-diagnostic.log")
        })
    }

    fn append(line: &str) {
        let _guard = WRITE_LOCK.lock().ok();
        let Some(path) = log_path() else { return };
        if let Some(parent) = path.parent() {
            if fs::create_dir_all(parent).is_err() { return; }
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{} | {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), line);
            let _ = file.flush();
        }
    }

    pub(super) fn checkpoint(message: &str) {
        append(&format!("CHECKPOINT: {message}"));
    }

    pub(super) fn install() {
        append("===== process start =====");
        checkpoint("panic hook installed before env_logger and Tauri");
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let message = info.payload().downcast_ref::<&str>().copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("<non-string panic payload>");
            append(&format!("PANIC: {message}; location={:?}; thread={:?}", info.location(), std::thread::current().name()));
            previous(info);
        }));
    }
}
