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
