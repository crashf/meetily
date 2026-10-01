// src/auto_record/server.rs
// Loopback-only HTTP trigger server for the Pund-IT Chrome extension.
// Endpoints: POST /trigger (start|stop), POST /heartbeat, GET /ping. OPTIONS supported for CORS.
// Auth: Authorization: Bearer <token> (token from auto_record.json store).
use super::{emit_event, load_config, now_ms, SessionMeta, STATE};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::io::Read;
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
}

#[derive(Serialize)]
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
        let Some((name, value)) = line.split_once(':') else { continue };
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

async fn handle_trigger<R: Runtime>(app: AppHandle<R>, req: TriggerRequest) -> (u16, serde_json::Value) {
    match req.action.as_str() {
        "start" => {
            let already = crate::audio::recording_commands::is_recording().await;
            if already {
                info!("auto-record: start requested but recording already active (idempotent ok)");
                emit_event(&app, "already-recording", serde_json::json!({"platform": req.platform}));
                return (200, ok_json(Some(true)));
            }

            let meeting_name = req
                .meeting_name
                .clone()
                .unwrap_or_else(|| "Auto-recorded meeting".to_string());
            {
                let mut session = STATE.session.lock().unwrap_or_else(|e| e.into_inner());
                *session = Some(SessionMeta {
                    meeting_name: meeting_name.clone(),
                    platform: req.platform.clone(),
                    trigger: "extension".to_string(),
                    started_at_ms: now_ms(),
                    last_heartbeat_ms: now_ms(),
                });
            }

            info!(
                "auto-record: starting recording for '{}' on {}",
                meeting_name, req.platform
            );
            match crate::audio::recording_commands::start_recording_with_devices_and_meeting(
                app.clone(),
                None,
                None,
                Some(meeting_name.clone()),
            )
            .await
            {
                Ok(()) => {
                    STATE.recording_active.store(true, Ordering::SeqCst);
                    emit_event(
                        &app,
                        "auto-record-started",
                        serde_json::json!({"meeting_name": meeting_name, "platform": req.platform}),
                    );
                    (200, ok_json(Some(true)))
                }
                Err(e) => {
                    error!("auto-record: start failed: {}", e);
                    if let Some(mut s) = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        emit_event(
                            &app,
                            "auto-record-error",
                            serde_json::json!({"meeting_name": s.meeting_name, "error": e}),
                        );
                    }
                    (503, err_json(format!("recording failed to start: {}", e)))
                }
            }
        }
        "stop" => {
            let was_active = crate::audio::recording_commands::is_recording().await;
            let save_path = crate::audio::recording_commands::get_meeting_folder_path()
                .await
                .unwrap_or(None)
                .unwrap_or_default();
            let args = crate::audio::recording_commands::RecordingArgs { save_path };
            match crate::audio::recording_commands::stop_recording(app.clone(), args).await {
                Ok(()) => {
                    let meta = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).take();
                    STATE.recording_active.store(false, Ordering::SeqCst);
                    if was_active {
                        info!("auto-record: stopped recording via extension trigger");
                        emit_event(
                            &app,
                            "auto-record-stopped",
                            serde_json::json!({"meeting_name": meta.map(|m| m.meeting_name).unwrap_or_default()}),
                        );
                    }
                    (200, ok_json(Some(false)))
                }
                Err(e) => {
                    error!("auto-record: stop failed: {}", e);
                    (503, err_json(format!("failed to stop recording: {}", e)))
                }
            }
        }
        other => (400, err_json(format!("unknown action: {}", other))),
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
        respond(&mut stream, 200, &serde_json::json!({"ok": true})).await;
        return;
    }

    // Auth check (token from store, so rotated tokens apply without restart)
    let cfg = load_config(&app).await;
    let expected = format!("Bearer {}", cfg.token);
    if parsed.authorization.as_deref() != Some(expected.as_str()) {
        warn!("auto-record: unauthorized request to {}", parsed.path);
        respond(&mut stream, 401, &err_json("unauthorized")).await;
        return;
    }

    match (parsed.method.as_str(), parsed.path.as_str()) {
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
        ("POST", "/heartbeat") => {
            let ts = now_ms();
            STATE.heartbeat.store(ts, Ordering::SeqCst);
            if let Some(session) = STATE.session.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                session.last_heartbeat_ms = ts;
            }
            respond(&mut stream, 200, &ok_json(None)).await;
        }
        ("GET", "/ping") => {
            let rec = crate::audio::recording_commands::is_recording().await;
            respond(&mut stream, 200, &ok_json(Some(rec))).await;
        }
        _ => respond(&mut stream, 404, &err_json("not found")).await,
    }
}

pub async fn run<R: Runtime>(app: AppHandle<R>) -> ServerExit {
    let cfg = load_config(&app).await;
    if !cfg.enabled {
        info!("auto-record: disabled; trigger server not started");
        return ServerExit::DisabledAtBoot;
    }

    let addr = format!("127.0.0.1:{}", cfg.port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("auto-record: failed to bind {}: {}", addr, e);
            emit_event(
                &app,
                "server-error",
                serde_json::json!({"error": e.to_string(), "port": cfg.port}),
            );
            return ServerExit::BindFailed(e.to_string());
        }
    };

    STATE.server_running.store(true, Ordering::SeqCst);
    info!("auto-record: trigger server listening on {}", addr);
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