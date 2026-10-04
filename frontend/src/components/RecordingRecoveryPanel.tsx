'use client';
import { useEffect, useState, useRef } from 'react';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
/** Persistent across routes/onboarding/recording-control permission gates. */
export function RecordingRecoveryPanel() {
  const state=useRecordingState();
  const latest=useRef(state);latest.current=state;
  const uiEpoch=useRef(0);
  const knownGeneration=useRef<number|null>(null);
  const refreshSequence=useRef(0);
  const refreshRef=useRef<()=>void>(()=>{});
  const [generation,setGeneration]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    let live=true;
    const refresh=()=>{const sequence=++refreshSequence.current;invoke<number|null>('recording_recovery_status').then(g=>{if(live&&sequence===refreshSequence.current){knownGeneration.current=g;setGeneration(g)}}).catch(()=>{})};
    refreshRef.current=refresh;
    const starts=listen('recording-started',()=>{uiEpoch.current++});
    const subscription=listen<{native_generation:number}>('recording-recovery-complete',async(event)=>{
      if(knownGeneration.current!==event.payload.native_generation)return;
      const epoch=uiEpoch.current;
      const active=await invoke<boolean>('is_recording').catch(()=>true);
      if(!active && epoch===uiEpoch.current && ![RecordingStatus.STARTING,RecordingStatus.SAVING,RecordingStatus.PROCESSING_TRANSCRIPTS].includes(latest.current.status))latest.current.setStatus(RecordingStatus.IDLE);
      refresh();
    });
    refresh();const timer=setInterval(refresh,2000);window.addEventListener('recording-recovery-refresh',refresh);
    return()=>{live=false;subscription.then(fn=>fn()).catch(()=>{});starts.then(fn=>fn()).catch(()=>{});clearInterval(timer);window.removeEventListener('recording-recovery-refresh',refresh)};
  },[]);
  if(generation===null)return null;
  return <div role="alert" className="fixed bottom-4 right-4 z-[100] max-w-md p-4 border rounded bg-amber-50 shadow-lg">
    <p>Recording cleanup is incomplete. Recover preserved files before starting again. Recovery does not save or summarize this meeting.</p>
    {error&&<p>{error}</p>}
    <button disabled={busy} onClick={async()=>{setBusy(true);try{await invoke('recover_failed_recording',{generation});setError(null);refreshRef.current()}catch(e){setError(String(e))}finally{setBusy(false)}}}>Retry recording recovery</button>
  </div>;
}
