// src/auto_record/server.rs
// Loopback-only HTTP trigger server for the Pund-IT Chrome extension.
// Endpoints: POST /trigger (start|stop), POST /heartbeat, GET /ping. OPTIONS supported for CORS.
// Auth: Authorization: Bearer <token> (token from auto_record.json store).
use super::{emit_event, load_config, now_ms, SessionMeta, STATE};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// POST /trigger body
#[derive(Debug, Deserialize)]
pub struct TriggerRequest {
    pub action: String, // "start" | "stop"
    pub platform: String,
    #[serde(default)]
    pub meeting_name: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub native_generation: Option<u64>,
}

#[derive(Serialize)]
#[allow(dead_code)] // kept: shape for future JSON responses; ok_json/err_json build equivalent maps today
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recording: Option<bool>,
}

/// Why the server exited (watchdog decides respawn from this).
pub enum ServerExit {
    DisabledAtBoot,
    BindFailed(String),
    ShutdownSignal,
}

pub fn signal_shutdown() {
    STATE.server_running.store(false, Ordering::SeqCst);
}

fn ok_json(recording: Option<bool>) -> serde_json::Value {
    serde_json::json!({ "ok": true, "recording": recording })
}

fn err_json(msg: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": msg.into() })
}

struct ParsedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

async fn read_request(stream: &mut TcpStream) -> Result<ParsedRequest, String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| format!("read: {}", e))?;
        if n == 0 {
            return Err("connection closed before headers complete".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(p) = find_headers_end(&buf) {
            break p;
        }
        if buf.len() > 256 * 1024 {
            return Err("request too large".into());
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut authorization = None;
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "authorization" {
            authorization = Some(value.to_string());
        } else if name == "content-length" {
            content_length = value.parse().unwrap_or(0);
        }
    }

    // Read the body (best effort within a deadline; loopback clients are fast).
    let mut body: Vec<u8> = buf[header_end..].to_vec();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while body.len() < content_length && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => body.extend_from_slice(&chunk[..n]),
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }
    body.truncate(content_length);

    Ok(ParsedRequest {
        method,
        path,
        authorization,
        body,
    })
}

async fn respond(stream: &mut TcpStream, status: u16, payload: &serde_json::Value) {
    let body = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    if let Err(e) = stream.write_all(response.as_bytes()).await {
        warn!("auto-record: failed to write response: {}", e);
    }
    let _ = stream.flush().await;
}

// Serialize session metadata with trigger/watchdog finalization. Native audio
// has its own shared lifecycle lock; this lock must always be acquired first.
pub(super) static TRIGGER_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

static EXTENSION_REQUESTS: crate::audio::lifecycle_policy::ExtensionRequests = crate::audio::lifecycle_policy::ExtensionRequests::new();
pub(super) static EXTENSION_START_PENDING: crate::audio::lifecycle_policy::PendingStarts = crate::audio::lifecycle_policy::PendingStarts::new();

async fn handle_trigger<R: Runtime>(
    app: AppHandle<R>,
    req: TriggerRequest,
) -> (u16, serde_json::Value) {
    // Capture epoch and register a counted RAII ticket before any queue wait.
    let start_epoch = crate::audio::recording_commands::stop_epoch();
    let _pending_extension_start = if req.action == "start" { Some(EXTENSION_START_PENDING.register()) } else { None };
    let request_id = req.request_id.clone();
    let request_ticket = if req.action == "start" {
        match &request_id { Some(id) if id.len() == 36 && uuid::Uuid::parse_str(id).is_ok() => Some(EXTENSION_REQUESTS.register(id.clone())), _ => return (400, err_json("start requires request_id")) }
    } else { None };
    if req.action == "stop" { if let Some(id) = &request_id { EXTENSION_REQUESTS.cancel(id); } }
    // Authenticated requests reach here. Publish stop BEFORE either queue.
    let extension_generation = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .filter(|s| s.trigger == "extension" && s.request_id == request_id && request_id.is_some()).map(|s| s.native_generation);
    // Cancel only matching extension tickets. Pending tickets do NOT own native
    // manual/gate startup and cannot publish its global stop epoch.
    // No global intent from HTTP ownership snapshots: targeted tickets cancel
    // extension initialization and conditional stop finalizes only its UUID.
    // Manual/gate epoch remains independent even with stale session metadata.
    if req.action == "start"
        && (crate::audio::recording_commands::stop_pending()
            || crate::audio::recording_commands::is_stopping())
    {
        return (409, err_json("recording is stopping"));
    }
    let _trigger_guard = TRIGGER_LOCK.lock().await;
    if req.action == "start"
        && (start_epoch != crate::audio::recording_commands::stop_epoch()
            || crate::audio::recording_commands::stop_pending())
    {
        return (409, err_json("start invalidated by stop"));
    }
    if request_ticket.as_ref().map_or(false, |t| t.cancelled()) { return (409, err_json("extension start cancelled")); }
    match req.action.as_str() {
        "recover_failed" => {
            let generation = match req.native_generation { Some(g) => g, None => return (400, err_json("explicit failed native_generation required")) };
            let authorized = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map_or(false, |s| s.trigger == "extension" && s.native_generation == generation && s.request_id == request_id && request_id.is_some());
            if !authorized { return (409, err_json("recovery belongs to another owner")); }
            match crate::audio::recording_commands::recover_failed_recording(app.clone(), generation).await {
                Ok(()) => {
                    let mut owner = STATE.session.lock().unwrap_or_else(|e| e.into_inner());
                    if owner.as_ref().map_or(false, |s| s.native_generation == generation) { owner.take(); }
                    STATE.recording_active.store(false, Ordering::SeqCst);
                    (200, serde_json::json!({"ok": true, "recording": false, "recovered_files": true, "saved_successfully": false}))
                }
                Err(e) => (503, err_json(e)),
            }
        }
        "start" => {
            super::debug::debug_log(
                &app,
                "trigger",
                "info",
                format!("POST /trigger start: platform={}, name={:?}", req.platform, req.meeting_name),
            );
            if crate::audio::recording_commands::is_stopping() {
                return (409, err_json("recording is stopping"));
            }
            let already = crate::audio::recording_commands::is_recording().await;
            if already {
                let failed = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                    .filter(|s| s.trigger == "extension" && s.cleanup_error.is_some()).cloned();
                if let Some(session) = failed {
                    let result = super::cleanup_superseded(&app, session).await;
                    return (503, err_json(format!("recording cleanup required; retry stop: {:?}", result)));
                }
                let owned = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                    .map_or(false, |s| s.trigger == "extension" && s.request_id == request_id && s.native_generation == crate::audio::recording_commands::recording_generation());
                if !owned { return (409, err_json("recording belongs to another owner")); }
                info!("auto-record: start requested but recording already active (idempotent ok)");
                super::debug::debug_log(&app, "trigger", "info", "start requested but recording already active (idempotent ok)".to_string());
                emit_event(&app, "already-recording", serde_json::json!({"platform": req.platform}));
                let id = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|s| s.request_id.clone());
                return (200, serde_json::json!({"ok": true, "recording": true, "request_id": id}));
            }

            let meeting_name = req
                .meeting_name
                .clone()
                .unwrap_or_else(|| "Auto-recorded meeting".to_string());
            let mut new_session = SessionMeta {
                    meeting_name: meeting_name.clone(),
                    platform: req.platform.clone(),
                    trigger: "extension".to_string(),
                    native_generation: 0,
                    cleanup_error: None,
                    request_id: request_id.clone(),
                    started_at_ms: now_ms(),
                    last_heartbeat_ms: now_ms(),
                };

            info!(
                "auto-record: starting recording for '{}' on {}",
                meeting_name, req.platform
            );
            let native_request_id = request_id.clone().unwrap_or_default();
            let recovery_receipt = std::sync::Arc::new(std::sync::Mutex::new(None));
            match crate::audio::recording_commands::start_gate_recording(
                app.clone(),
                meeting_name.clone(),
                start_epoch,
                move || !EXTENSION_REQUESTS.is_cancelled(&native_request_id),
                recovery_receipt.clone(),
            )
            .await
            {
                Ok(generation) => {
                    if generation != crate::audio::recording_commands::recording_generation()
                        || !crate::audio::recording_commands::is_recording().await
                        || start_epoch != crate::audio::recording_commands::stop_epoch()
                        || crate::audio::recording_commands::stop_pending()
                        || request_ticket.as_ref().map_or(false, |t| t.cancelled())
                    {
                        new_session.native_generation = generation;
                        if let Err(e) = super::cleanup_superseded(&app, new_session).await {
                            return (503, serde_json::json!({"ok": false, "error": format!("superseded start cleanup failed; retry stop: {}", e), "retry_stop": true, "request_id": request_id}));
                        }
                        return (409, err_json("start superseded by stop"));
                    }
                    new_session.native_generation = generation;
                    *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_session);
                    STATE.recording_active.store(true, Ordering::SeqCst);
                    super::debug::debug_log(&app, "trigger", "info", format!("recording started: '{}' ({})", meeting_name, req.platform));
                    super::notify::notify(
                        &app,
                        "Recording started",
                        &format!("{} — {} meeting", meeting_name, req.platform),
                    );
                    emit_event(
                        &app,
                        "auto-record-started",
                        serde_json::json!({"meeting_name": meeting_name, "platform": req.platform}),
                    );
                    (200, serde_json::json!({"ok": true, "recording": true, "request_id": request_id}))
                }
                Err(e) => {
                    if let Some(generation) = *recovery_receipt.lock().unwrap() {
                        new_session.native_generation = generation;
                        new_session.cleanup_error = Some(e.clone());
                        *STATE.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_session);
                        return (503, serde_json::json!({"ok": false, "recording": false, "error": e, "retry_stop": true, "request_id": request_id, "native_generation": generation}));
                    }
                    error!("auto-record: start failed: {}", e);
                    super::debug::debug_log(&app, "trigger", "error", format!("start failed: {}", e));
                    super::notify::notify(
                        &app,
                        "Auto-record failed to start",
                        &format!("{} — {}", meeting_name, truncate_err(&e)),
                    );
                    emit_event(&app, "auto-record-error",
                        serde_json::json!({"meeting_name": meeting_name, "error": e}));
                    (503, err_json(format!("recording failed to start: {}", e)))
                }
            }
        }
        "stop" => {
            if extension_generation.is_none() && request_id.is_none() { return (200, ok_json(Some(false))); } // never publish stop intent for another owner
            super::debug::debug_log(&app, "trigger", "info", "POST /trigger stop".to_string());
            let save_path = crate::audio::recording_commands::get_meeting_folder_path()
                .await
                .unwrap_or(None)
                .unwrap_or_default();
            let args = crate::audio::recording_commands::RecordingArgs { save_path };
            let generation = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                .filter(|s| s.trigger == "extension" && s.request_id == request_id && request_id.is_some()).map(|s| s.native_generation).unwrap_or(0);
            match crate::audio::recording_commands::stop_recording_if_generation(app.clone(), args, generation, move || {
                STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                    .map_or(false, |s| s.trigger == "extension" && s.native_generation == generation)
            }).await {
                Ok(did_stop) => {
                    let mut owner = STATE.session.lock().unwrap_or_else(|e| e.into_inner());
                    let meta = if owner.as_ref().map_or(false, |s| s.trigger == "extension" && s.native_generation == generation) {
                        owner.take()
                    } else { None };
                    if meta.is_some() { STATE.recording_active.store(false, Ordering::SeqCst); }
                    drop(owner);
                    let stopped_name = meta
                        .as_ref()
                        .map(|m| m.meeting_name.clone())
                        .unwrap_or_default();
                    if did_stop {
                        info!("auto-record: stopped recording via extension trigger");
                        super::debug::debug_log(
                            &app,
                            "trigger",
                            "info",
                            "recording stopped via extension trigger".to_string(),
                        );
                        super::notify::notify(&app, "Recording stopped & saved", &stopped_name);
                        emit_event(
                            &app,
                            "auto-record-stopped",
                            serde_json::json!({"meeting_name": stopped_name}),
                        );
                        super::emit_post_processing_complete(&app);
                    }
                    (200, ok_json(Some(false)))
                }
                Err(e) => {
                    error!("auto-record: stop failed: {}", e);
                    super::debug::debug_log(&app, "trigger", "error", format!("stop failed: {}", e));
                    (503, err_json(format!("failed to stop recording: {}", e)))
                }
            }
        }
        other => (400, err_json(format!("unknown action: {}", other))),
    }
}

fn truncate_err(e: &str) -> String {
    let one_line = e.replace('\n', " ");
    if one_line.chars().count() > 120 {
        format!("{}…", one_line.chars().take(120).collect::<String>())
    } else {
        one_line
    }
}

async fn handle_connection<R: Runtime>(app: AppHandle<R>, mut stream: TcpStream) {
    let parsed = match tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream)).await
    {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            warn!("auto-record: bad request: {}", e);
            return;
        }
        Err(_) => {
            warn!("auto-record: request read timed out");
            return;
        }
    };

    if parsed.method == "OPTIONS" {
        super::debug::debug_log(&app, "server", "info", "OPTIONS preflight".to_string());
        respond(&mut stream, 200, &serde_json::json!({"ok": true})).await;
        return;
    }

    // Auth check (token from store, so rotated tokens apply without restart)
    let cfg = load_config(&app).await;
    let expected = format!("Bearer {}", cfg.token);
    if parsed.authorization.as_deref() != Some(expected.as_str()) {
        warn!("auto-record: unauthorized request to {}", parsed.path);
        super::debug::debug_log(
            &app,
            "server",
            "warn",
            format!(
                "unauthorized request to {} (header {}) — token mismatch or missing; extension must paste the token from Pund-IT Meeting Assistant → Settings → Preferences → Auto-record",
                parsed.path,
                if parsed.authorization.is_some() { "present but wrong" } else { "absent" }
            ),
        );
        respond(&mut stream, 401, &err_json("unauthorized")).await;
        return;
    }

    let route_path = parsed.path.split('?').next().unwrap_or(&parsed.path);
    match (parsed.method.as_str(), route_path) {
        ("POST", "/trigger") => {
            let req: Result<TriggerRequest, String> = serde_json::from_slice(&parsed.body)
                .map_err(|e| format!("invalid body: {}", e));
            match req {
                Ok(req) => {
                    let (status, payload) = handle_trigger(app, req).await;
                    respond(&mut stream, status, &payload).await;
                }
                Err(e) => respond(&mut stream, 400, &err_json(e)).await,
            }
        }
        ("GET" | "POST", "/heartbeat") => {
            // Worker has sent GET since v1.1 (no body); POST accepted too. The old
            // POST-only route 404'd every extension heartbeat — the extension
            // deadman never armed (PUN-801 log-6: 'alarm heartbeat failed: 404').
            let ts = now_ms();
            let request_id = parsed.path.split_once('?').and_then(|(_, query)| query.split('&')
                .find_map(|part| part.strip_prefix("request_id=")));
            if let Some(session) = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                if session.trigger == "extension" && session.cleanup_error.is_none() && session.request_id.as_deref() == request_id && request_id.is_some() {
                    STATE.heartbeat.store(ts, Ordering::SeqCst);
                    session.last_heartbeat_ms = ts;
                }
            }
            respond(&mut stream, 200, &ok_json(None)).await;
        }
        ("GET", "/ping") => {
            if parsed.path.split_once('?').map_or(false, |(_, q)| q.split('&').any(|v| v == "capability=1")) {
                respond(&mut stream, 200, &serde_json::json!({"ok":true,"ownership_protocol":2})).await;
                return;
            }
            // Trigger publication and native transitions share this lock order.
            // Never return a settled ownership loss from a half-published start.
            let trigger_guard = TRIGGER_LOCK.lock().await;
            let engine_guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
            let rec = crate::audio::recording_commands::is_recording().await;
            let generation = crate::audio::recording_commands::recording_generation();
            let session = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let mut status = ok_json(Some(rec));
            status["extension_owned"] = serde_json::json!(rec && session.as_ref()
                .map_or(false, |s| s.trigger == "extension" && s.cleanup_error.is_none() && s.native_generation == generation));
            status["ownership_protocol"] = serde_json::json!(2);
            status["request_id"] = serde_json::json!(session.as_ref().filter(|s| s.native_generation == generation).and_then(|s| s.request_id.clone()));
            status["native_generation"] = serde_json::json!(session.as_ref().filter(|s|s.native_generation==generation).map(|s|s.native_generation));
            status["cleanup_error"] = serde_json::json!(session.as_ref().filter(|s|s.native_generation==generation).and_then(|s| s.cleanup_error.clone()));
            status["stop_requested"] = serde_json::json!(crate::audio::recording_commands::stop_requested());
            status["stopping"] = serde_json::json!(crate::audio::recording_commands::is_stopping());
            drop(engine_guard); drop(trigger_guard);
            respond(&mut stream, 200, &status).await;
        }
        _ => respond(&mut stream, 404, &err_json("not found")).await,
    }
}

pub async fn run<R: Runtime>(app: AppHandle<R>) -> ServerExit {
    let cfg = load_config(&app).await;
    if !cfg.enabled {
        info!("auto-record: disabled; trigger server not started");
        super::debug::debug_log(&app, "server", "info", "auto-record disabled; trigger server not started".to_string());
        return ServerExit::DisabledAtBoot;
    }

    let addr = format!("127.0.0.1:{}", cfg.port);
    // Bind with inline retries: after a config-change restart the old listener may
    // take a moment to release the port — a single bind attempt + 30s watchdog
    // backoff left up to a 30s "not running" window (PUN-801 field finding).
    let listener = {
        let mut last_err = String::new();
        let mut acquired = None;
        for attempt in 0..12 {
            match TcpListener::bind(&addr).await {
                Ok(l) => {
                    acquired = Some(l);
                    break;
                }
                Err(e) => {
                    last_err = format!("{}", e);
                    super::debug::debug_log(
                        &app,
                        "server",
                        "warn",
                        format!("bind attempt {}/12 failed ({}); retrying in 300ms", attempt + 1, e),
                    );
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }
        match acquired {
            Some(l) => l,
            None => {
                error!("auto-record: failed to bind {}: {}", addr, last_err);
                super::debug::debug_log(&app, "server", "error", format!("failed to bind {} after retries: {}", addr, last_err));
                super::notify::notify_throttled(
                    &app,
                    "bind-fail",
                    10 * 60_000,
                    "Pund-IT Meeting Assistant trigger server down",
                    &format!("Pund-IT Meeting Assistant could not listen on {} — the browser extension cannot trigger recording. ({})", addr, last_err),
                );
                emit_event(
                    &app,
                    "server-error",
                    serde_json::json!({"error": last_err, "port": cfg.port}),
                );
                return ServerExit::BindFailed(last_err);
            }
        }
    };

    STATE.server_running.store(true, Ordering::SeqCst);
    info!("auto-record: trigger server listening on {}", addr);
    super::debug::debug_log(&app, "server", "info", format!("trigger server listening on {}", addr));
    emit_event(&app, "server-started", serde_json::json!({"port": cfg.port}));

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        tokio::spawn(handle_connection(app, stream));
                    }
                    Err(e) => {
                        warn!("auto-record: accept error: {}", e);
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                if !STATE.server_running.load(Ordering::SeqCst) {
                    info!("auto-record: shutdown signal received; server stopping");
                    break;
                }
            }
        }
    }

    STATE.server_running.store(false, Ordering::SeqCst);
    ServerExit::ShutdownSignal
}