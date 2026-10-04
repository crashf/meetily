use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use anyhow::Result;
use log::{info, warn, error};
use tauri::{AppHandle, Runtime, Emitter};
use tokio::sync::mpsc;
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

use super::recording_state::AudioChunk;
use super::audio_processing::create_meeting_folder;
use super::incremental_saver::IncrementalAudioSaver;

/// Structured transcript segment for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub audio_start_time: f64, // Seconds from recording start
    pub audio_end_time: f64,   // Seconds from recording start
    pub duration: f64,          // Segment duration in seconds
    pub display_time: String,   // Formatted time for display like "[02:15]"
    pub confidence: f32,
    pub sequence_id: u64,
}

/// Meeting metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub version: String,
    pub meeting_id: Option<String>,
    pub meeting_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo,
    pub audio_file: String,
    pub transcript_file: String,
    pub sample_rate: u32,
    pub status: String,  // "recording", "completed", "error"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub microphone: Option<String>,
    pub system_audio: Option<String>,
}

/// Coalesced, session-owned writer. Event callbacks update memory and enqueue
/// at most one wakeup; storage I/O never runs on transcription workers.
struct TranscriptWriter {
    wake: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    io: Arc<Mutex<()>>,
    task: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Drop for TranscriptWriter {
    fn drop(&mut self) {
        self.wake.lock().unwrap().take();
        // Abnormal drop cannot block the runtime; normal release explicitly joins
        // this task inside the retained publication job before owner release.
        if let Some(task) = self.task.lock().unwrap().take() { std::thread::spawn(move || { let _ = task.join(); }); }
    }
}
#[derive(Clone)]
pub struct TranscriptSink {
    segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    writer: Arc<TranscriptWriter>,
}
impl TranscriptSink {
    pub fn add(&self, segment: TranscriptSegment) {
        {
            let mut segments = self.segments.lock().unwrap();
            if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) { *existing = segment; }
            else { segments.push(segment); }
        }
        if let Some(wake)=self.writer.wake.lock().unwrap().as_ref() { let _ = wake.try_send(()); } // bounded coalescing, never block a worker
    }
}

/// New recording saver using incremental saving strategy
pub struct RecordingSaver {
    incremental_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    meeting_folder: Option<PathBuf>,
    meeting_name: Option<String>,
    metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    transcript_writer: Mutex<Option<Arc<TranscriptWriter>>>,
    accumulation_error: Option<String>,
    accumulation_task_failed: bool,
    audio_required: bool,
    finalized_audio: Option<PathBuf>,
    finalization_task: Option<tokio::task::JoinHandle<Result<PathBuf,String>>>,
    recovery_publication: Arc<Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>>,
    audio_recovery_task: Arc<Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>>,
    accumulation_stop: Option<tokio::sync::oneshot::Sender<()>>,
    accumulation_task: Option<tokio::task::JoinHandle<Result<(), String>>>,
}

impl RecordingSaver {
    pub fn new() -> Self {
        Self {
            incremental_saver: None,
            meeting_folder: None,
            meeting_name: None,
            metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())),
            transcript_writer: Mutex::new(None),
            accumulation_error: None,
            accumulation_task_failed: false,
            audio_required: false,
            finalized_audio: None,
            finalization_task: None,
            recovery_publication: Arc::new(Mutex::new(None)),
            audio_recovery_task: Arc::new(Mutex::new(None)),
            accumulation_stop: None,
            accumulation_task: None,
        }
    }

    pub fn transcript_sink(&self) -> TranscriptSink {
        let mut slot = self.transcript_writer.lock().unwrap();
        let writer = slot.get_or_insert_with(|| {
            let (wake, receiver) = std::sync::mpsc::sync_channel(1);
            let io = Arc::new(Mutex::new(()));
            let write_lock = io.clone();
            let segments = self.transcript_segments.clone();
            let folder = self.meeting_folder.clone();
            let task = std::thread::spawn(move || {
                while receiver.recv().is_ok() {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    while receiver.try_recv().is_ok() {}
                    let _write = write_lock.lock().unwrap();
                    let snapshot = segments.lock().unwrap().clone();
                    if let Some(folder) = &folder {
                        let result = serde_json::to_vec(&serde_json::json!({"version":"1.0","segments":snapshot,"last_updated":chrono::Utc::now().to_rfc3339(),"total_segments":snapshot.len()})).map_err(|e|e.to_string()).and_then(|bytes| {
                            let temp=folder.join("transcripts.sink.tmp");
                            std::fs::write(&temp,bytes).map_err(|e|e.to_string()).and_then(|_|super::incremental_saver::publish_durable(&temp,&folder.join("transcripts.json")).map_err(|e|e.to_string()))
                        });
                        if let Err(e)=result { error!("Transcript writer failed; snapshot retained for final retry: {}",e); }
                    }
                }
            });
            Arc::new(TranscriptWriter { wake:Mutex::new(Some(wake)), io, task: Mutex::new(Some(task)) })
        }).clone();
        TranscriptSink { segments: self.transcript_segments.clone(), writer }
    }

    /// Set the meeting name for this recording session
    pub fn set_meeting_name(&mut self, name: Option<String>) {
        self.meeting_name = name;
    }

    /// Set device information in metadata
    pub fn set_device_info(&mut self, mic_name: Option<String>, sys_name: Option<String>) {
        if let Some(ref mut metadata) = self.metadata {
            metadata.devices.microphone = mic_name;
            metadata.devices.system_audio = sys_name;

            // Write updated metadata to disk if folder exists
            if let Some(folder) = &self.meeting_folder {
                let metadata_clone = metadata.clone();
                if let Err(e) = self.write_metadata(folder, &metadata_clone) {
                    warn!("Failed to update metadata with device info: {}", e);
                }
            }
        }
    }

    /// Add or update a structured transcript segment (upserts based on sequence_id)
    /// Also saves incrementally to disk
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        if let Ok(mut segments) = self.transcript_segments.lock() {
            // Check if segment with same sequence_id exists (update it)
            if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) {
                *existing = segment.clone();
                info!("Updated transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            } else {
                // New segment, add it
                segments.push(segment.clone());
                info!("Added new transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            }
        } else {
            error!("Failed to lock transcript segments for adding segment {}", segment.id);
        }

        // NEW: Save incrementally to disk
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                warn!("Failed to write incremental transcript update: {}", e);
            }
        }
    }

    /// Legacy method for backward compatibility - converts text to basic segment
    pub fn add_transcript_chunk(&self, text: String) {
        let segment = TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()),
            text,
            audio_start_time: 0.0,
            audio_end_time: 0.0,
            duration: 0.0,
            display_time: "[00:00]".to_string(),
            confidence: 1.0,
            sequence_id: 0,
        };
        self.add_transcript_segment(segment);
    }

    /// Start accumulation with optional incremental saving
    ///
    /// # Arguments
    /// * `auto_save` - If true, creates checkpoints and enables saving. If false, audio chunks are discarded.
    pub fn start_accumulation(
        &mut self,
        auto_save: bool,
        mut receiver: mpsc::UnboundedReceiver<AudioChunk>,
    ) {
        self.audio_required = auto_save;
        if auto_save {
            info!("Initializing incremental audio saver for recording (auto-save ENABLED)");
        } else {
            info!("Starting recording without audio saving (auto-save DISABLED - transcripts only)");
        }

        // Initialize meeting folder and incremental saver ONLY if auto_save is enabled
        if auto_save {
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, true) {
                    Ok(()) => info!("Successfully initialized meeting folder with checkpoints"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                        // Continue anyway - will use fallback flat structure
                    }
                }
            }
        } else {
            // When auto_save is false, still create meeting folder for transcripts/metadata
            // but skip .checkpoints directory
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, false) {
                    Ok(()) => info!("Successfully initialized meeting folder (transcripts only)"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                    }
                }
            }
        }

        // Start accumulation task
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
        self.accumulation_stop = Some(stop_tx);
        let incremental_saver_arc = self.incremental_saver.clone();
        let save_audio = auto_save;

        self.accumulation_task = Some(tokio::spawn(async move {
            info!("Recording saver accumulation task started (save_audio: {})", save_audio);

            let mut closing = false;
            let mut accumulation_error = None;
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = &mut stop_rx, if !closing => {
                        receiver.close(); // reject new producers, drain every already accepted chunk
                        closing = true;
                        continue;
                    }
                    chunk = receiver.recv() => match chunk { Some(chunk) => chunk, None => break },
                };

                // Only process audio chunks if auto_save is enabled
                if save_audio {
                    // Add chunk to incremental saver
                    if let Some(saver_arc) = &incremental_saver_arc {
                        let saver=saver_arc.clone();
                        let written=tokio::task::spawn_blocking(move || saver.blocking_lock().add_chunk(chunk).map_err(|e|e.to_string())).await;
                        if written.is_err(){panic!("audio checkpoint worker lost an accepted chunk");}
                        if let Err(e) = written.map_err(|e|e.to_string()).and_then(|r|r) {
                            error!("Failed to add chunk to incremental saver: {}", e);
                            accumulation_error = Some(e.to_string());
                        }
                    } else {
                        error!("Incremental saver not available while accumulating");
                    }
                } else {
                    // auto_save is false: discard audio chunk (no-op)
                    // Transcription already happened in the pipeline before this point
                }
            }

            info!("Recording saver accumulation task ended");
            match accumulation_error { Some(e) => Err(e), None => Ok(()) }
        }));
    }

    /// Initialize meeting folder structure and metadata
    ///
    /// # Arguments
    /// * `meeting_name` - Name of the meeting
    /// * `create_checkpoints` - Whether to create .checkpoints/ directory and IncrementalAudioSaver
    fn initialize_meeting_folder(&mut self, meeting_name: &str, create_checkpoints: bool) -> Result<()> {
        // Load preferences to get base recordings folder
        let base_folder = super::recording_preferences::get_default_recordings_folder();

        // Create meeting folder structure (with or without .checkpoints/ subdirectory)
        let meeting_folder = create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?;

        // Only initialize incremental saver if checkpoints are needed (auto_save is true)
        if create_checkpoints {
            let incremental_saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000)?;
            self.incremental_saver = Some(Arc::new(AsyncMutex::new(incremental_saver)));
            info!("✅ Incremental audio saver initialized for meeting: {}", meeting_name);
        } else {
            info!("⚠️  Skipped incremental audio saver (auto-save disabled)");
        }

        // Create initial metadata
        let metadata = MeetingMetadata {
            version: "1.0".to_string(),
            meeting_id: None,  // Will be set by backend
            meeting_name: Some(meeting_name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None,  // Could be enhanced to store actual device names
                system_audio: None,
            },
            audio_file: if create_checkpoints { "audio.mp4".to_string() } else { "".to_string() },
            transcript_file: "transcripts.json".to_string(),
            sample_rate: 48000,
            status: "recording".to_string(),
        };

        // Write initial metadata.json
        self.meeting_folder = Some(meeting_folder.clone());
        self.metadata = Some(metadata.clone());
        self.write_metadata(&meeting_folder, &metadata)?;

        Ok(())
    }

    /// Write metadata.json to disk (atomic write with temp file)
    fn write_metadata(&self, folder: &PathBuf, metadata: &MeetingMetadata) -> Result<()> {
        let metadata_path = folder.join("metadata.json");
        let temp_path = folder.join(".metadata.json.tmp");

        let json_string = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&temp_path, json_string)?;
        super::incremental_saver::publish_durable(&temp_path, &metadata_path)?;  // Atomic

        Ok(())
    }

    /// Write transcripts.json to disk (atomic write with temp file and validation)
    fn write_transcripts_json(&self, folder: &PathBuf) -> Result<()> {
        // Final durable publication is ordered with every background write. Once
        // transcription is drained no subsequent writer can publish older data.
        let writer = self.transcript_writer.lock().unwrap().clone();
        let _write = writer.as_ref().map(|w| w.io.lock().unwrap());
        // Clone segments to avoid holding lock during I/O
        let segments_clone = if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            error!("Failed to lock transcript segments for writing");
            return Err(anyhow::anyhow!("Failed to lock transcript segments"));
        };

        info!("Writing {} transcript segments to JSON", segments_clone.len());

        let transcript_path = folder.join("transcripts.json");
        let temp_path = folder.join(".transcripts.json.tmp");

        // Create JSON structure
        let json = serde_json::json!({
            "version": "1.0",
            "segments": segments_clone,
            "last_updated": chrono::Utc::now().to_rfc3339(),
            "total_segments": segments_clone.len()
        });

        // Serialize to pretty JSON string
        let json_string = serde_json::to_string_pretty(&json)
            .map_err(|e| {
                error!("Failed to serialize transcripts to JSON: {}", e);
                anyhow::anyhow!("JSON serialization failed: {}", e)
            })?;

        // Write to temp file with error handling
        std::fs::write(&temp_path, &json_string)
            .map_err(|e| {
                error!("Failed to write transcript temp file to {}: {}", temp_path.display(), e);
                anyhow::anyhow!("Failed to write temp file: {}", e)
            })?;

        // Verify temp file was written correctly
        if !temp_path.exists() {
            error!("Temp transcript file does not exist after write: {}", temp_path.display());
            return Err(anyhow::anyhow!("Temp file verification failed"));
        }

        // Atomic rename
        super::incremental_saver::publish_durable(&temp_path, &transcript_path)
            .map_err(|e| {
                error!("Failed to rename transcript file from {} to {}: {}",
                       temp_path.display(), transcript_path.display(), e);
                anyhow::anyhow!("Failed to rename transcript file: {}", e)
            })?;

        info!("✅ Successfully wrote transcripts.json with {} segments", segments_clone.len());
        Ok(())
    }

    // in frontend/src-tauri/src/audio/recording_saver.rs
    pub fn get_stats(&self) -> (usize, u32) {
        if let Some(ref saver) = self.incremental_saver {
            if let Ok(guard) = saver.try_lock() {
                (guard.get_checkpoint_count() as usize, 48000)
            } else {
                (0, 48000)
            }
        } else {
            (0, 48000)
        }
    }

    async fn drain_accumulation(&mut self) -> Result<(), String> {
        if let Some(stop) = self.accumulation_stop.take() { let _ = stop.send(()); }
        if let Some(task) = self.accumulation_task.as_mut() {
            let joined = task.await;
            self.accumulation_task_failed = joined.is_err();
            let result = joined.map_err(|e| format!("Audio saver task failed: {}", e)).and_then(|r| r);
            self.accumulation_task.take(); // only remove after completed await; cancellation keeps ownership
            if let Err(e) = result { self.accumulation_error = Some(e); }
        }
        match &self.accumulation_error { Some(e) => Err(e.clone()), None => Ok(()) }
    }

    /// Independent failure recovery: exactly-once receiver drain, retryable tail persistence.
    pub async fn preserve_recoverable_audio(&mut self) -> Result<(), String> {
        if let Some(task)=self.finalization_task.as_mut(){
            let result=task.await;self.finalization_task.take();
            self.finalized_audio=Some(result.map_err(|e|e.to_string())??);
        }
        let drained = self.drain_accumulation().await;
        {
            let mut slot = self.audio_recovery_task.lock().unwrap();
            if slot.is_none() {
                let finalized = self.finalized_audio.clone();
                let saver = self.incremental_saver.clone();
                let required = self.audio_required;
                *slot = Some(tokio::task::spawn_blocking(move || {
                    if let Some(path)=finalized { std::fs::OpenOptions::new().write(true).open(path).and_then(|f|f.sync_all()).map_err(|e|e.to_string())?; }
                    if let Some(saver)=saver { saver.blocking_lock().persist_tail().map_err(|e|e.to_string()) }
                    else if required { Err("required audio saver unavailable; accepted audio may be lost".into()) } else { Ok(()) }
                }));
            }
        }
        let persisted = Self::await_recovery_publication(self.audio_recovery_task.clone()).await;
        if persisted.is_ok() && !self.accumulation_task_failed {
            // add_chunk appends before its retryable checkpoint write. A durable
            // tail accounts for all accepted data; a lost task never does.
            self.accumulation_error = None;
            return Ok(());
        }
        drained.and(persisted)
    }

    pub fn recovery_publication_task(&self) -> Result<Arc<Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>>, String> {
        let folder = self.meeting_folder.clone().ok_or_else(|| "recovery transcript folder unavailable".to_string())?;
        let metadata = self.metadata.clone();
        let segments = self.transcript_segments.clone();
        let writer = self.transcript_writer.lock().unwrap().clone();
        let mut slot = self.recovery_publication.lock().unwrap();
        if slot.is_none() {
            *slot = Some(tokio::task::spawn_blocking(move || {
                if let Some(writer)=&writer {
                    writer.wake.lock().unwrap().take(); // close enqueue channel after transcript drain
                    let task=writer.task.lock().unwrap().take();
                    if let Some(task)=task { task.join().map_err(|_| "transcript writer shutdown failed".to_string())?; }
                }
                let _write = writer.as_ref().map(|w| w.io.lock().unwrap());
                let snapshot = segments.lock().unwrap().clone();
                let bytes = serde_json::to_vec(&serde_json::json!({"version":"1.0","segments":snapshot,"last_updated":chrono::Utc::now().to_rfc3339(),"total_segments":snapshot.len()})).map_err(|e|e.to_string())?;
                let temp=folder.join("transcripts.final.tmp");
                std::fs::write(&temp,bytes).map_err(|e|e.to_string())?;
                super::incremental_saver::publish_durable(&temp,&folder.join("transcripts.json")).map_err(|e|e.to_string())?;
                if let Some(metadata)=metadata {
                    let temp=folder.join("metadata.final.tmp");
                    std::fs::write(&temp,serde_json::to_vec_pretty(&metadata).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                    super::incremental_saver::publish_durable(&temp,&folder.join("metadata.json")).map_err(|e|e.to_string())?;
                }
                Ok(())
            }));
        }
        drop(slot);
        Ok(self.recovery_publication.clone())
    }

    pub async fn await_recovery_publication(task: Arc<Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>>) -> Result<(), String> {
        // Drop restores the handle on outer timeout/cancellation as well as our
        // own timeout; no detached writer can be raced by a retry.
        struct PendingPublication {
            owner: Arc<Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>>,
            handle: Option<tokio::task::JoinHandle<Result<(), String>>>,
        }
        impl Drop for PendingPublication {
            fn drop(&mut self) { if let Some(handle)=self.handle.take() { *self.owner.lock().unwrap()=Some(handle); } }
        }
        let handle=task.lock().unwrap().take().ok_or_else(|| "recovery publication already being awaited".to_string())?;
        let mut pending=PendingPublication{owner:task,handle:Some(handle)};
        match tokio::time::timeout(std::time::Duration::from_secs(30), pending.handle.as_mut().unwrap()).await {
            Err(_) => Err("durable transcript publication pending; retry recovery".into()),
            Ok(result) => { pending.handle.take(); result.map_err(|e|format!("durable publication task failed: {}",e))? },
        }
    }

    pub fn mark_failed_metadata(&mut self) {
        if let Some(metadata)=self.metadata.as_mut(){metadata.status="recovery_required".into();metadata.completed_at=None;}
    }

    pub async fn persist_failed_recovery_transcripts(&self) -> Result<(), String> {
        // First settle any old completed-candidate publication, then always
        // publish the retained non-completed metadata in a fresh ordered job.
        let pending = self.recovery_publication.lock().unwrap().is_some();
        if pending { Self::await_recovery_publication(self.recovery_publication.clone()).await?; }
        self.persist_recovery_transcripts().await
    }

    pub async fn persist_recovery_transcripts(&self) -> Result<(), String> {
        Self::await_recovery_publication(self.recovery_publication_task()?).await
    }

    /// Stop and save using incremental saving approach
    ///
    /// # Arguments
    /// * `app` - Tauri app handle for emitting events
    /// * `recording_duration` - Actual recording duration in seconds (from RecordingState)
    pub async fn stop_and_save<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        recording_duration: Option<f64>
    ) -> Result<Option<String>, String> {
        info!("Stopping recording saver");

        if let Err(drain_error) = self.drain_accumulation().await {
            let recovery = self.preserve_recoverable_audio().await;
            if let Err(e) = recovery { return Err(format!("{}; tail recovery: {}", drain_error, e)); }
            self.drain_accumulation().await?;
        }

        // Check if incremental saver exists (indicates auto_save was enabled)
        if self.meeting_folder.is_none() || self.metadata.is_none() { return Err("recording initialization incomplete; recovery required".into()); }
        if self.audio_required && self.incremental_saver.is_none() { return Err("required audio saver initialization failed".into()); }
        let should_save_audio = self.incremental_saver.is_some();

        self.persist_recovery_transcripts().await?;
        if !should_save_audio {
            info!("⚠️  No audio saver initialized (auto-save was disabled) - skipping audio finalization");
            if let Some(metadata)=self.metadata.as_mut(){metadata.status="completed".into();metadata.completed_at=Some(chrono::Utc::now().to_rfc3339());metadata.duration_seconds=recording_duration;}
            self.persist_recovery_transcripts().await?;
            return Ok(None);
        }

        // Finalize incremental saver (merge checkpoints into final audio.mp4)
        let final_audio_path = if let Some(path) = &self.finalized_audio {
            path.clone()
        } else if let Some(saver_arc) = &self.incremental_saver {
            if self.finalization_task.is_none() {
                let saver=saver_arc.clone();
                self.finalization_task=Some(tokio::task::spawn_blocking(move || {
                    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e|e.to_string())?;
                    runtime.block_on(async {saver.lock().await.finalize().await.map_err(|e|e.to_string())})
                }));
            }
            let joined=self.finalization_task.as_mut().unwrap().await;
            self.finalization_task.take();
            let path=joined.map_err(|e|format!("audio finalization task failed: {}",e))??;
            self.finalized_audio = Some(path.clone());
            path
        } else {
            error!("No incremental saver initialized - cannot save recording");
            return Err("No incremental saver initialized".to_string());
        };

        // Update metadata to completed status with actual recording duration
        if let Some(mut metadata) = self.metadata.clone() {
            metadata.status = "completed".to_string();
            metadata.completed_at = Some(chrono::Utc::now().to_rfc3339());

            // Use actual recording duration from RecordingState (more accurate than transcript segments)
            // Falls back to last transcript segment if duration not provided
            metadata.duration_seconds = recording_duration.or_else(|| {
                if let Ok(segments) = self.transcript_segments.lock() {
                    segments.last().map(|seg| seg.audio_end_time)
                } else {
                    None
                }
            });

            let previous=self.metadata.clone();
            self.metadata=Some(metadata.clone());
            if let Err(e)=self.persist_recovery_transcripts().await { self.metadata=previous; return Err(e); }

            info!("✅ Metadata updated with duration: {:?}s", metadata.duration_seconds);
        }

        // Emit save event with audio and transcript paths
        let save_event = serde_json::json!({
            "audio_file": final_audio_path.to_string_lossy(),
            "transcript_file": self.meeting_folder.as_ref()
                .map(|f| f.join("transcripts.json").to_string_lossy().to_string()),
            "meeting_name": self.meeting_name,
            "meeting_folder": self.meeting_folder.as_ref()
                .map(|f| f.to_string_lossy().to_string())
        });

        if let Err(e) = app.emit("recording-saved", &save_event) {
            warn!("Failed to emit recording-saved event: {}", e);
        }

        // Keep the final session snapshot until its background writer is dropped
        // and joined. A queued wake must never publish an empty final transcript.

        Ok(Some(final_audio_path.to_string_lossy().to_string()))
    }

    /// Get the meeting folder path (for passing to backend)
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> {
        self.meeting_folder.as_ref()
    }

    /// Get accumulated transcript segments (for reload sync)
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> {
        if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            Vec::new()
        }
    }

    /// Get meeting name (for reload sync)
    pub fn get_meeting_name(&self) -> Option<String> {
        self.meeting_name.clone()
    }
}

impl Default for RecordingSaver {
    fn default() -> Self {
        Self::new()
    }
}
