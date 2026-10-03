#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // Install first so even early startup panics are recorded before Tauri.
    #[cfg(target_os = "windows")]
    app_lib::startup_diagnostic::install();

    // Tauri's log plugin owns the process logger (stdout + meetily.log).
    // Do not initialize env_logger here: log allows only one global logger.
    // Early Windows checkpoints/panics use the independent diagnostic file.
    #[cfg(target_os = "windows")]
    app_lib::startup_diagnostic::checkpoint("calling app_lib::run");
    app_lib::run();
}
