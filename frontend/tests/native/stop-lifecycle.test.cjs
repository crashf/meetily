function section(s,a,b){const x=s.indexOf(a),y=s.indexOf(b,x+1);assert.ok(x>=0 && y>x,`section ${a} to ${b}`);return s.slice(x,y)}
function before(source,a,b){const x=source.indexOf(a),y=source.indexOf(b);assert.ok(x>=0,`missing ${a}`);assert.ok(y>=0,`missing ${b}`);assert.ok(x<y,`${a} before ${b}`)}
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../src-tauri/src');
const audio = fs.readFileSync(path.join(root, 'audio/recording_commands.rs'), 'utf8').replace(/\r\n/g,'\n');
const server = fs.readFileSync(path.join(root, 'auto_record/server.rs'), 'utf8').replace(/\r\n/g,'\n');
const watchdog = fs.readFileSync(path.join(root, 'auto_record/watchdog.rs'), 'utf8').replace(/\r\n/g,'\n');
const stop = section(audio,'async fn stop_recording_checked','/// Check if recording is active');
test('both starts and stop use one engine lifecycle lock', () => {
 assert.equal((audio.match(/acquire_engine_lifecycle_lock\(\)/g) || []).length, 4);
 before(stop,'acquire_engine_lifecycle_lock()','if !IS_RECORDING.load');
 before(stop,'acquire_engine_lifecycle_lock()','RECORDING_MANAGER.lock().unwrap().take()');
 assert.ok(stop.includes('let _engine_lifecycle_guard'));
});
test('intent published before waiting and ping reports stop without token disclosure', () => {
 before(section(audio,'pub async fn stop_recording_with_outcome','pub async fn recover_failed_recording'),'publish_stop_intent()','stop_recording_checked(');
 assert.ok(audio.includes('LIFECYCLE.started(start_epoch);'));
 assert.ok(server.includes('status["stop_requested"]'));
 assert.ok(server.includes('status["stopping"]'));
});
test('shutdown failure retains ownership and no false handoff (source wiring only)', () => {
 assert.ok(stop.includes('*RECORDING_MANAGER.lock().unwrap() = manager_for_cleanup.0.take();'));
 assert.ok(stop.includes('return Ok(false)'));
 assert.ok(stop.includes('Ok(true)'));
 assert.ok(server.includes('if did_stop {'));
 assert.ok(watchdog.includes('if did_stop {'));
});
test('watchdog reconciles session identity and heartbeat under trigger ownership', () => {
 before(watchdog,'server::TRIGGER_LOCK.lock().await','current.started_at_ms != session.started_at_ms');
 assert.ok(watchdog.includes('saturating_sub(current.last_heartbeat_ms) <= HEARTBEAT_DEADMAN_MS'));
});
test('prior heartbeat GET/POST and postprocessing handoff remain', () => {
 assert.ok(server.includes('(\"GET\" | \"POST\", \"/heartbeat\") =>'));
 assert.ok(server.includes('super::emit_post_processing_complete(&app)'));
 assert.ok(watchdog.includes('super::emit_post_processing_complete(&app)'));
});
const gate=fs.readFileSync(path.join(root,'auto_record/audio_gate.rs'),'utf8').replace(/\r\n/g,'\n');
const saver=fs.readFileSync(path.join(root,'audio/recording_saver.rs'),'utf8').replace(/\r\n/g,'\n');
const incremental=fs.readFileSync(path.join(root,'audio/incremental_saver.rs'),'utf8').replace(/\r\n/g,'\n');
const tray=fs.readFileSync(path.join(root,'tray.rs'),'utf8').replace(/\r\n/g,'\n');
test('no-op tray stop refreshes both handlers without post-processing',()=>{
 assert.equal((tray.match(/if !did_stop \{ update_tray_menu_async\(&app_clone\).await; return; \}/g)||[]).length,2);
});
test('manual and device starts capture and validate tickets before native lifecycle wait (source contract)',()=>{
 const manual=section(audio,'pub async fn start_recording_with_meeting_name','pub async fn start_recording_with_devices');
 const devices=section(audio,'async fn start_recording_with_devices_policy','pub async fn stop_recording');
 for(const source of [manual,devices]) {
  before(source,'let start_epoch =','acquire_engine_lifecycle_lock()');
  before(source,'acquire_engine_lifecycle_lock()','LIFECYCLE.allows_start(start_epoch)');
 }
});
test('gate revalidates active ownership after trigger lock and never installs provisional metadata',()=>{
 const start=section(gate,'// Status observed before acquiring','} else if recording && gate_owns');
 before(start,'is_recording().await','let session = SessionMeta');
 assert.ok(!start.includes('.is_some()')); // inactive stale metadata must not permanently block gate
 before(start,'start_gate_recording(','= Some(session)');
 assert.ok(!start.includes('= None;'));
 before(server,'start_gate_recording(','= Some(new_session)');
 assert.ok(!section(server,'let mut new_session','"stop" =>').includes('.take()'));
});
test('failed stop preserves recovery audio independently without successful handoff (source contract)',()=>{
 before(stop,'manager.preserve_recoverable_audio().await','*RECORDING_MANAGER.lock().unwrap() = manager_for_cleanup');
 assert.ok(saver.includes('receiver.close()'));
 assert.ok(saver.includes('let joined = task.await' ));
 assert.ok(saver.includes('drained.and(persisted)'));
 const tail=section(incremental,'pub fn persist_tail','/// Finalize the recording');
 before(tail,'self.save_checkpoint()?','self.checkpoint_buffer.clear()');
 assert.ok(!tail.includes('remove_dir_all'));
});
test('hot swap phase 3 requires live identity and tears down stale stream outside manager lock (source contract)',()=>{
 const swap=section(audio,'// Phase 3: validate live session','/// Background processor');
 assert.ok(swap.includes('manager.is_recording() && recording_live()'));
 assert.ok(swap.includes('_ => Some(new_stream)'));
 before(swap,'if let Some(stream) = rejected','let _ = stream.stop()');
});
test('stream failure still drains pipeline before independent saver recovery (source contract)',()=>{
 const manager=fs.readFileSync(path.join(root,'audio/recording_manager.rs'),'utf8').replace(/\r\n/g,'\n');
 const shutdown=section(manager,'pub async fn stop_streams_and_force_flush','pub async fn preserve_recoverable_audio');
 assert.ok(shutdown.includes('let mut shutdown_error = self.shutdown.check().err()'));
 assert.ok(!shutdown.includes('map_err(anyhow::Error::msg)?'));
 before(shutdown,'.force_flush_and_stop()','if let Some(e) = shutdown_error');
 assert.ok(stop.includes('return Err(format!("Recording save failed:'));
 assert.ok(stop.includes('return Err(format!("Recording save timed out;'));
});
test('extension status and conditional stop cannot adopt or stop a newer desktop generation (source contract)',()=>{
 assert.ok(server.includes('status["extension_owned"]'));
 assert.ok(server.includes('recording belongs to another owner'));
 assert.ok(server.includes('never publish stop intent for another owner'));
 assert.ok(server.includes('s.trigger == "extension" && s.native_generation == generation'));
});
test('saver join cancellation retains handle and consumed error remains sticky (source contract)',()=>{
 assert.ok(saver.includes('self.accumulation_task.as_mut()'));
 before(saver,'let joined = task.await' ,'self.accumulation_task.take()');
 assert.ok(saver.includes('self.accumulation_error = Some(e)'));
 assert.ok(saver.includes('Some(e) => Err(e.clone())'));
 assert.ok(saver.includes('self.finalized_audio = Some(path.clone())'));
});
test('pending extension startup can be cancelled without committing provisional session (source contract)',()=>{
 assert.ok(server.includes('EXTENSION_REQUESTS.cancel(id)'));
 assert.ok(server.includes('Some(EXTENSION_START_PENDING.register())'));
 assert.ok(server.includes('super::cleanup_superseded(&app, new_session).await'));
 assert.ok(server.indexOf('EXTENSION_START_PENDING.register()')<server.indexOf('TRIGGER_LOCK.lock().await',server.indexOf('async fn handle_trigger')));
});
test('flush errors do not discard accepted raw pipeline chunks and gate silence eligibility is live (source contract)',()=>{
 const pipeline=fs.readFileSync(path.join(root,'audio/pipeline.rs'),'utf8').replace(/\r\n/g,'\n');
 const run=section(pipeline,'pub async fn run(mut self)','fn flush_remaining_audio');
 assert.ok(!run.includes('self.flush_remaining_audio()?'));
 assert.ok(run.includes('flush_error = Some(e)'));
 assert.ok(gate.includes('&& live_silence_eligible()'));
 assert.ok(gate.includes('LAST_PROBE_SPEECH.store(at_ms'));
});

test('superseded cleanup retains explicit retry owner and rejected stop preserves replacement (source wiring)',()=>{
 const module=fs.readFileSync(path.join(root,'auto_record/mod.rs'),'utf8').replace(/\r\n/g,'\n');
 before(module,'= Some(session)','let result = crate::audio::recording_commands::stop_recording_if_generation');
 assert.ok(module.includes('s.cleanup_error = Some(e.clone())'));
 assert.ok(gate.includes('s.cleanup_error.is_some()).cloned()'));
 before(gate,'let cleanup =','if !cached_cfg.enabled');
 assert.ok(server.includes('let meta = if owner.as_ref().map_or(false'));
 assert.ok(server.includes('if meta.is_some() { STATE.recording_active.store(false'));
});
test('targeted cancellation and explicit failed recovery remain generation isolated (source contracts)',()=>{
 const recovery=section(audio,'async fn recover_failed_recording_locked','pub async fn stop_recording_if_generation');
 before(recovery,'generation != recording_generation()','RECORDING_MANAGER.lock().unwrap().take()');
 before(recovery,'!manager.has_terminal_shutdown_error()','manager.stop_streams_and_force_flush().await');
 before(recovery,'!manager.failed_session_resources_closed()','IS_RECORDING.store(false');
 before(recovery,'manager.preserve_recoverable_audio().await','IS_RECORDING.store(false');
 assert.ok(!recovery.includes('recording-stopped'));assert.ok(!recovery.includes('emit_post_processing_complete'));
 assert.ok(recovery.includes('*TRANSCRIPTION_TASK.lock().unwrap()=Some(task)'));
 assert.ok(server.includes('s.request_id == request_id && request_id.is_some()'));
 assert.ok(server.includes('s.cleanup_error.is_some()).cloned()'));
 before(server,'let extension_generation =','let _trigger_guard');
 const admission=section(server,'let extension_generation =','let _trigger_guard',server.indexOf('let extension_generation ='));
 assert.ok(!admission.includes('EXTENSION_START_PENDING.any()'));
 assert.ok(saver.includes('persisted.is_ok() && !self.accumulation_task_failed'));
 assert.ok(gate.includes('let at_ms = monotonic_ms()'));assert.ok(gate.includes('let now = monotonic_ms()'));
});
test('ordering helper fails closed for either missing safety operation',()=>{
 assert.throws(()=>before('clear','persist','clear'));assert.throws(()=>before('persist','persist','clear'));
});
test('recovery drain preserves global saver listener until successful join (source contract)',()=>{
 const r=section(audio,'pub async fn recover_failed_recording','pub async fn stop_recording_if_generation');
 before(r,'drop(owner);','match tokio::time::timeout');
 before(r,'Ok(Ok(Ok(())))','app.unlisten(id)');
 assert.ok(r.includes('persist_drain_failure(error).await'));
 assert.ok(r.includes('persist_failed_recovery_transcripts().await?'));
 assert.ok(audio.includes('manager.mark_save_failed()'));
 assert.ok(saver.includes('else if required { Err('));
 assert.ok(server.includes('session.request_id.as_deref() == request_id'));
 const admission=section(server,'let extension_generation =','let _trigger_guard',server.indexOf('let extension_generation ='));
 assert.ok(!admission.includes('publish_stop_intent()'));
});
test('normal drain retains global saver and task across timeout and checkpoint publish is retryable (source contracts)',()=>{
 const native=section(audio,'// Retain globally visible saver','// Step 3: Now safely unload');
 before(native,'*RECORDING_MANAGER.lock().unwrap() = manager_for_cleanup','tokio::time::timeout');
 before(native,'Ok(Ok(Ok(())))','app.unlisten(listener_id)');
 assert.ok(native.includes('*TRANSCRIPTION_TASK.lock().unwrap() = transcription_task.0.take()'));
 assert.ok(native.includes('persist_drain_failure(error).await'));
 const r=section(audio,'pub async fn recover_failed_recording','pub async fn stop_recording_if_generation');
 before(r,'persist_failed_recovery_transcripts().await?','completion.release(&mut *RECORDING_MANAGER.lock().unwrap())?;');
 assert.ok(incremental.includes('uuid::Uuid::new_v4()'));
 before(incremental,'publish_durable(&temporary_path, &checkpoint_path)','self.checkpoint_count += 1');
 assert.ok(audio.includes('Recording started event failed:'));
});
test('session transcript sink remains independent of taken manager and gate admission is under native lock (source wiring)',()=>{
 assert.equal((audio.match(/sink.add\(segment\)/g)||[]).length,2);
 assert.ok(saver.includes('pub struct TranscriptSink'));
 const policy=section(audio,'async fn start_recording_with_devices_policy','pub async fn stop_recording');
 before(policy,'acquire_engine_lifecycle_lock()','eligible.as_ref().map_or(false');
 assert.ok(gate.includes('config_epoch == super::GATE_CONFIG_EPOCH.load'));
 before(saver,'self.meeting_folder = Some(meeting_folder.clone())','self.write_metadata(&meeting_folder, &metadata)?');
 before(incremental,'OpenOptions::new().write(true).open(temp)?.sync_all()?','MoveFileExW(from.as_ptr()');
});
test('native manager checks admission after awaited preparation immediately before streams (source contract)',()=>{
 const manager=fs.readFileSync(path.join(root,'audio/recording_manager.rs'),'utf8').replace(/\r\n/g,'\n');
 before(manager,'if !admitted()','self.stream_manager.start_streams');
 assert.equal((audio.match(/\.start_recording\([^\n]*LIFECYCLE.allows_start/g)||[]).length,2);
 const callback=section(gate,'fn send_rms(','/// Rolling window');assert.ok(!callback.includes('HEALTHY_SILENCE.lock()'));
});
test('failed startup has explicit native recovery identity and both callers publish retry ownership (static wiring)',()=>{
 const manager=fs.readFileSync(path.join(root,'audio/recording_manager.rs'),'utf8');
 assert.ok(audio.includes('let retained = manager.startup_recovery_required()'));
 assert.equal((audio.match(/if RECORDING_MANAGER.lock\(\).unwrap\(\).is_some\(\)/g)||[]).length,2);
 assert.ok(manager.includes('return Err(self.rollback_start("Start cancelled before capture"'));
 assert.ok(manager.includes('return Err(self.rollback_start("Start superseded during stream initialization"'));
 assert.ok(manager.includes('Stream initialization failed:'));
 before(manager.slice(manager.indexOf('async fn rollback_start')),'stop_streams_and_force_flush().await','preserve_recoverable_audio().await');
 assert.ok(server.includes('"retry_stop": true, "request_id": request_id, "native_generation": generation'));
 for(const source of [gate,server])assert.ok(source.includes('*recovery_receipt.lock().unwrap()'));
 before(stop,'let recovery_generation =','if !IS_RECORDING.load');
 assert.ok(stop.includes('recover_failed_recording_locked(app, generation).await?'));
});
test('failed extension cleanup retries before live heartbeat admission and gate uses current evidence (static wiring)',()=>{
 before(watchdog,'if session.cleanup_error.is_some()','let rec =');
 assert.ok(watchdog.includes('super::cleanup_superseded(&app, current).await'));
 assert.ok(!gate.includes('evidence_deadline'));
 assert.ok(gate.includes('monotonic_ms().saturating_sub(LAST_PROBE_SPEECH'));
 assert.throws(()=>section('no boundaries','missing-start','missing-end'));
});
test('desktop Stop always publishes intent and recovery release uses production completion policy (static wiring)',()=>{
 const lib=fs.readFileSync(path.join(root,'lib.rs'),'utf8');const command=section(lib,'async fn stop_recording','async fn is_recording');
 assert.ok(!command.includes('is_recording().await'));assert.ok(command.includes('stop_recording_with_outcome('));assert.ok(command.includes('Ok(false)'));
 const r=section(audio,'async fn recover_failed_recording_locked','pub async fn stop_recording_if_generation');
 before(r,'persist_failed_recovery_transcripts().await?','completion.transcripts_durable = true');before(r,'completion.transcripts_durable = true','completion.release(');
 assert.ok(!r.includes('post-processing-complete'));assert.ok(!r.includes('recording-stopped'));
 for(const source of [gate,server])assert.ok(!source.includes('generation_before_start'));
});
test('failed startup retains transcription receiver, sink precedes drain and final audio precedes checkpoint deletion (source wiring)',()=>{
 const m=fs.readFileSync(path.join(root,'audio/recording_manager.rs'),'utf8');
 assert.ok(m.includes('self.startup_transcription=Some(transcription_receiver)'));
 const r=section(audio,'async fn recover_failed_recording_locked','pub async fn stop_recording_if_generation');
 before(r,'manager.take_startup_transcription()','start_transcription_task(app.clone(), receiver)');before(r,'app.listen("transcript-update"','start_transcription_task(app.clone(), receiver)');
 const f=section(incremental,'pub async fn finalize','async fn merge_checkpoints');before(f,'publish_durable(&pending,&final_audio_path)','remove_dir_all');
 assert.ok(saver.includes('let _ = wake.try_send(())'));
 const add=section(saver,'impl TranscriptSink','/// New recording saver');assert.ok(!add.includes('std::fs::write'));
 assert.ok(saver.includes('let _write = writer.as_ref().map(|w| w.io.lock().unwrap())'));
});
test('successful start listeners precede task spawn and final segments survive pending writer wakes (source wiring)',()=>{
 for(const source of [section(audio,'pub async fn start_recording_with_meeting_name','pub async fn start_recording_with_devices'),section(audio,'async fn start_recording_with_devices_policy','pub async fn stop_recording')])before(source,'app.listen("transcript-update"','start_transcription_task(app.clone(), transcription_receiver)');
 assert.ok(!saver.includes('segments.clear()'));
});
test('ping derives one coherent owner snapshot under trigger/native lock order (static wiring)',()=>{const ping=section(server,'("GET", "/ping")','_ => respond');before(ping,'TRIGGER_LOCK.lock().await','acquire_engine_lifecycle_lock().await');assert.equal((ping.match(/STATE.session.lock/g)||[]).length,1);before(ping,'let session =','status["request_id"]');});

test('duplicate starts preserve already-active UI semantic and explicit Stop retries terminal sessions',()=>{for(const source of [section(audio,'pub async fn start_recording_with_meeting_name','pub async fn start_recording_with_devices'),section(audio,'async fn start_recording_with_devices_policy','pub async fn stop_recording')])before(source,'Recording already in progress','Previous recording owns unfinished cleanup');assert.ok(stop.includes('m.has_terminal_shutdown_error()'));const lib=fs.readFileSync(path.join(root,'lib.rs'),'utf8');assert.ok(lib.includes('            recover_failed_recording,'));});
test('desktop no-save outcome skips analytics/handoff and final write owns cancellation-safe task (source wiring)',()=>{const controls=fs.readFileSync(path.join(__dirname,'../../src/components/RecordingControls.tsx'),'utf8');before(controls,'if (result !== true)','Analytics.trackTranscriptionSuccess()');assert.ok(controls.includes('No post-processing callback for recovered/no-op completion'));assert.ok(saver.includes('impl Drop for PendingPublication'));assert.ok(saver.includes('self.persist_recovery_transcripts().await?'));const r=section(audio,'async fn recover_failed_recording_locked','pub async fn stop_recording_if_generation');before(r,'let mut owner=RecoveryOwner','persist_failed_recovery_transcripts().await?');});

test('capability returns before lifecycle waits and transcription propagates true drain outcome',()=>{const ping=section(server,'("GET", "/ping")','_ => respond');before(ping,'return;','TRIGGER_LOCK.lock().await');const w=fs.readFileSync(path.join(root,'audio/transcription/worker.rs'),'utf8');assert.ok(w.includes('JoinHandle<Result<(), String>>'));assert.ok(w.includes('if drain_failed.load'));assert.ok(audio.includes('Ok(Ok(Err(error)))'));});
