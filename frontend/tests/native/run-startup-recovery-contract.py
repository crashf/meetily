#!/usr/bin/env python3
"""Execute the production rollback method and production ownership policy with
injected flush/persistence outcomes. No CPAL/Tauri/codec integration claimed."""
from pathlib import Path
import subprocess, tempfile
root=Path(__file__).resolve().parents[2]/'src-tauri/src/audio'
s=(root/'recording_manager.rs').read_text()
a=s.index('    async fn rollback_start(');b=s.index('    pub fn mark_interrupted_start',a)
method=s[a:b].replace('RecordingStartError::Other(anyhow::Error::msg(', 'RecordingStartError::Other(').replace('reason, flushed, persisted)))','reason, flushed, persisted))')
program='''
#[path="/source/lifecycle_policy.rs"] mod policy;
#[derive(Debug)] enum RecordingStartError { Other(String) }
struct RecordingManager { startup_failed:bool,save_failed:bool,startup_transcription:Option<()>,flush_failed:bool,persist_failed:bool,closed:bool,tail:Vec<u8>,durable:Vec<u8>,flushes:usize,drains:usize }
impl RecordingManager {
 fn mark_save_failed(&mut self){self.save_failed=true;}
 async fn stop_streams_and_force_flush(&mut self)->Result<(),String>{self.closed=true;if self.flushes==0{self.drains+=1;}self.flushes+=1;if self.flush_failed{Err("injected VAD flush failure".into())}else{Ok(())}}
 async fn preserve_recoverable_audio(&mut self)->Result<(),String>{if self.persist_failed{return Err("injected disk failure".into())}self.durable.extend(self.tail.drain(..));Ok(())}
'''+method+'''}
fn run<F:std::future::Future>(f:F)->F::Output {
 struct Wake;impl std::task::Wake for Wake {fn wake(self:std::sync::Arc<Self>) {}}
 let w=std::task::Waker::from(std::sync::Arc::new(Wake));let mut cx=std::task::Context::from_waker(&w);let mut f=Box::pin(f);
 match f.as_mut().poll(&mut cx){std::task::Poll::Ready(v)=>v,_=>panic!("injected operations must be immediately ready")}
}
fn manager(flush_failed:bool,persist_failed:bool)->RecordingManager{RecordingManager{startup_failed:false,save_failed:false,startup_transcription:None,flush_failed,persist_failed,closed:false,tail:vec![1,2,3],durable:vec![],flushes:0,drains:0}}
#[test] fn cancellation_disk_failure_keeps_exact_owner_and_tail_then_retry(){
 let lifecycle=policy::Lifecycle::new();let stop=lifecycle.request_stop();let mut m=manager(false,true);let error=run(m.rollback_start("cancelled after streams".into()));
 assert!(format!("{:?}",error).contains("disk failure"));assert!(m.closed);assert_eq!(m.tail,vec![1,2,3]);
 let needs=m.startup_failed;let mut slot=None;assert!(policy::retain_start_failure(&mut slot,m,needs));let generation=lifecycle.failed_start();assert_eq!(generation,1);assert!(lifecycle.requested());drop(stop);
 assert!(slot.is_some());let m=slot.as_mut().unwrap();assert!(run(m.preserve_recoverable_audio()).is_err());assert_eq!(m.tail,vec![1,2,3]);m.persist_failed=false;run(m.preserve_recoverable_audio()).unwrap();assert_eq!(m.durable,vec![1,2,3]);assert!(m.tail.is_empty());run(m.preserve_recoverable_audio()).unwrap();assert_eq!(m.durable,vec![1,2,3]);assert_eq!(m.drains,1);let mut completion=policy::RecoveryCompletion{resources_closed:true,audio_durable:true,transcripts_drained:false,transcripts_durable:false};assert!(completion.release(&mut slot).is_err());completion.transcripts_drained=true;assert!(completion.release(&mut slot).is_err());assert!(slot.is_some());completion.transcripts_durable=true;completion.release(&mut slot).unwrap();assert!(slot.is_none());
}
#[test] fn cancellation_flush_failure_keeps_owner_even_if_tail_durable(){let mut m=manager(true,false);run(m.rollback_start("cancelled before capture".into()));assert!(m.startup_failed&&m.save_failed&&m.closed);assert_eq!(m.durable,vec![1,2,3]);let needs=m.startup_failed;let mut slot=None;assert!(policy::retain_start_failure(&mut slot,m,needs));assert!(slot.is_some());assert!(slot.as_ref().unwrap().save_failed);}
#[test] fn receiver_only_clean_rollback_retains_exact_owner(){let mut m=manager(false,false);m.startup_transcription=Some(());run(m.rollback_start("cancelled".into()));assert!(m.startup_failed);let needs=m.startup_failed;let mut slot=None;policy::retain_start_failure(&mut slot,m,needs);assert!(slot.as_ref().unwrap().startup_transcription.is_some());}
#[test] fn clean_cancellation_releases_without_recovery_owner(){let mut m=manager(false,false);run(m.rollback_start("cancelled".into()));assert!(!m.startup_failed);assert!(m.closed);assert!(m.tail.is_empty());let mut slot=None;assert!(!policy::retain_start_failure(&mut slot,m,false));assert!(slot.is_none());}
#[test] #[should_panic(expected="cannot replace a recovery owner")] fn failed_owner_cannot_be_replaced(){let mut slot=Some(manager(true,true));policy::retain_start_failure(&mut slot,manager(false,false),true);}
'''
with tempfile.TemporaryDirectory() as temp:
 Path(temp,'contracts.rs').write_text(program)
 subprocess.run(['docker','run','--rm','-v',f'{temp}:/tests:ro','-v',f'{root}:/source:ro','rust:1.85-slim','sh','-c','rustc --edition=2021 --test /tests/contracts.rs -o /tmp/tests && /tmp/tests'],check=True)
