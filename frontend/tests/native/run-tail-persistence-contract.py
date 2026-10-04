#!/usr/bin/env python3
"""Compile actual production persist_tail and shutdown policy with injected
checkpoint publication. Proves buffer/phase transition, not FFmpeg/Windows fsync."""
from pathlib import Path
import tempfile,subprocess
root=Path(__file__).resolve().parents[2]/'src-tauri/src/audio'
s=(root/'incremental_saver.rs').read_text();a=s.index('    pub fn persist_tail(');b=s.index('    /// Finalize',a)
method=s[a:b]
program='''#[path="/source/lifecycle_policy.rs"] mod policy;
type Result<T> = std::result::Result<T,String>;
struct Saver { checkpoint_buffer:Vec<u8>, fail:bool, disk:Vec<u8>,writes:usize }
impl Saver { fn save_checkpoint(&mut self)->Result<()> {self.writes+=1;if self.fail{return Err("injected durable publication failure".into())}self.disk.extend(&self.checkpoint_buffer);Ok(())}
'''+method+'''}
#[test] fn actual_tail_retains_buffer_on_publication_error_and_retry_does_not_duplicate(){let mut s=Saver{checkpoint_buffer:vec![1,2,3],fail:true,disk:vec![],writes:0};assert!(s.persist_tail().is_err());assert_eq!(s.checkpoint_buffer,vec![1,2,3]);assert!(s.disk.is_empty());s.fail=false;s.persist_tail().unwrap();assert_eq!(s.disk,vec![1,2,3]);assert!(s.checkpoint_buffer.is_empty());s.persist_tail().unwrap();assert_eq!(s.writes,2);assert_eq!(s.disk,vec![1,2,3]);}
#[test] fn actual_shutdown_policy_never_replays_completed_stages(){let mut p=policy::ShutdownProgress::default();p.stream_result(Ok(())).unwrap();assert!(p.streams_stopped);assert!(p.pipeline_result(Err("flush lost".into())).is_err());p.pipeline_stopped=true;assert!(p.check().is_err());assert!(p.streams_stopped&&p.pipeline_stopped);assert!(p.check().is_err());}
'''
with tempfile.TemporaryDirectory() as temp:
 Path(temp,'test.rs').write_text(program)
 subprocess.run(['docker','run','--rm','-v',f'{temp}:/tests:ro','-v',f'{root}:/source:ro','rust:1.85-slim','sh','-c','rustc --edition=2021 --test /tests/test.rs -o /tmp/tests && /tmp/tests'],check=True)
