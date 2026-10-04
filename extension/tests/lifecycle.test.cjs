const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');
async function harness(saved={}, failures={}) {
 let pingFail=false, bodyFail=false, cleanupFail=false;
 let requestTimeout=null, recordingId=saved.recordingControl?.sessionId || 'restored-id', cancelled=new Set(), delayedStop=null;
 const pendingStarts=new Map();
 let nativeEpoch=0, nativeStart=null, startSignal=null, stopSignal=null, lostResponse=false;
 let now=failures.now || 100000, recording=!!failures.recording, nativeOwner='extension', nativeGeneration=0, failStart=false, failStop=false, stopGate=null, startGate=null, pingGate=null, stopRequested=false, stopping=false, badge='', calls=[], transports=[];
 const registeredAlarms=new Set();const currentDocuments=new Map();
 const session=structuredClone(saved),local={token:'test',port:7788};
 const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn)}});
 const storage=(data)=>({async get(defaults){if(failures.storageGet && data===session)throw Error('storage read');return {...defaults,...data}},async set(value){if(failures.storageSet && data===session)throw Error('storage write');const changes={};for(const [key,newValue] of Object.entries(value)){const oldValue=data[key];if(JSON.stringify(oldValue)!==JSON.stringify(newValue))changes[key]={oldValue:structuredClone(oldValue),newValue:structuredClone(newValue)}}Object.assign(data,structuredClone(value));if(Object.keys(changes).length)for(const listener of chrome.storage.onChanged.listeners)listener(changes,data===local?'local':'session')}});
 const chrome={webNavigation:{onCommitted:event(),async getFrame({tabId,frameId}){return {documentId:currentDocuments.get(`${tabId}:${frameId}`)}}},storage:{local:storage(local),session:storage(session),onChanged:event()},
 runtime:{onMessage:event(),onInstalled:event(),onStartup:event(),getManifest:()=>({version:'1.4.0'})},
 action:{async setBadgeText({text}){badge=text},async setBadgeBackgroundColor(){}},
 tabs:{async query(){if(failures.query)throw Error('query');return failures.tabs || [{id:1,url:'https://meet.google.com/abc-defg-hij'}]},onRemoved:event(),onUpdated:event()},
 alarms:{create(name){registeredAlarms.add(name)},clear(name){registeredAlarms.delete(name)},onAlarm:event()},notifications:{create(){}},contextMenus:{onClicked:event(),removeAll(fn){fn()},create(){}},scripting:{async executeScript(){return []}}};
 const context=vm.createContext({chrome,console,URL,AbortController,TextEncoder,crypto:{randomUUID:require('node:crypto').randomUUID,subtle:{async digest(_,bytes){return require('node:crypto').createHash('sha256').update(bytes).digest()}}},setTimeout:(fn,ms)=>{if(ms===30000)requestTimeout=fn;return setTimeout(fn,ms)},clearTimeout,Date:class extends Date{static now(){return now}},fetch:async(url,opts)=>{
  transports.push({url,authorization:opts.headers.Authorization,body:opts.body?JSON.parse(opts.body):null});const body=opts.body?JSON.parse(opts.body):{};const action=body.action || null; calls.push(action||url.split('/').pop().split('?')[0]);
  let ok=true,json={ok:true,recording,extension_owned:recording && nativeOwner==='extension',ownership_protocol:failures.legacy?1:2,native_generation:nativeGeneration,request_id:recordingId,stop_requested:stopRequested,stopping};
  if(!action && url.endsWith('/ping')){if(pingFail)throw Error('ping transport');if(pingGate)await pingGate;}
  if(action==='start'){
   startSignal=opts.signal; const startAbort=requestTimeout;startSignal.testAbort=startAbort; const epoch=nativeEpoch;const id=body.request_id;pendingStarts.set(id,true);
   // Native initialization continues independently of HTTP disconnection.
   nativeStart=(async()=>{if(startGate)await startGate;ok=!failStart && epoch===nativeEpoch && !cancelled.has(id) && (!recording || (nativeOwner==='extension' && recordingId===id));if(ok){if(!recording)nativeGeneration++;recording=true;nativeOwner='extension';recordingId=id};pendingStarts.delete(id);json={ok,recording,request_id:recordingId};})();
   const aborted=new Promise((_,reject)=>{if(opts.signal.aborted)reject(Error('AbortError'));else opts.signal.addEventListener('abort',()=>reject(Error('AbortError')),{once:true})});
   await Promise.race([nativeStart,aborted]);if(cleanupFail){ok=false;json={ok:false,retry_stop:true,request_id:id,error:'cleanup failed'};} if(lostResponse)throw Error('response lost after native completion');
  }
  if(action==='stop'){
   stopSignal=opts.signal;
   const nativeStop=(async()=>{
    if(delayedStop)await delayedStop;
    const target=body.request_id;
    if(pendingStarts.has(target))cancelled.add(target);
    if(target===recordingId && target)nativeEpoch++;
    if(nativeStart)await nativeStart;if(stopGate)await stopGate;ok=!failStop;
    if(ok && nativeOwner==='extension' && target===recordingId && target!==null && target!==undefined)recording=false;
    json={ok,recording: target===recordingId ? recording : false};
   })();
   const aborted=new Promise((_,reject)=>{if(opts.signal.aborted)reject(Error('AbortError'));else opts.signal.addEventListener('abort',()=>reject(Error('AbortError')),{once:true})});
   await Promise.race([nativeStop,aborted]);
  }
  return {ok,status:ok?200:503,async json(){if(bodyFail && action==='start')throw Error('body aborted');return json}};
 }});
 vm.runInContext(fs.readFileSync(__dirname+'/../background.js','utf8'),context);await vm.runInContext('bootReady',context);
 return {session,calls,transports,context,currentDocuments,async commit(frameId=0){for(const fn of chrome.webNavigation.onCommitted.listeners)fn({tabId:1,frameId});await tick()},set pingFail(v){pingFail=v},set bodyFail(v){bodyFail=v},set cleanupFail(v){cleanupFail=v},set delayedStop(v){delayedStop=v},get recordingId(){return recordingId},abortStart(){requestTimeout()},get stopSignal(){return stopSignal},get startSignal(){return startSignal},set lostResponse(v){lostResponse=v},async nativeSettled(){await nativeStart},async removed(id=1){await chrome.tabs.onRemoved.listeners[0](id)},async updated(url){await chrome.tabs.onUpdated.listeners[0](1,{url},{id:1,url})},set startGate(v){startGate=v},set pingGate(v){pingGate=v}, set stopRequested(v){stopRequested=v},set stopping(v){stopping=v},failures,get badge(){return badge},get recording(){return recording},set recording(v){recording=v},set nativeOwner(v){nativeOwner=v;nativeGeneration++},set failStart(v){failStart=v},set failStop(v){failStop=v},set stopGate(v){stopGate=v},advance(ms){now+=ms},async run(code){return vm.runInContext(code,context)},async sensor(platform='meet',joined=true,extra={}){context.msg={kind:'SENSOR',platform,url:platform==='teams'?'https://teams.cloud.microsoft/':platform==='zoom'?'https://us.zoom.us/wc/123/join':'https://meet.google.com/abc-defg-hij',isTop:true,joined,media:false,lobby:false,...extra};await vm.runInContext('handleSensor(msg,{tab:{id:1},frameId:0})',context)},get alarmRegistered(){return registeredAlarms.has('meetily-hb')},async alarm(){if(registeredAlarms.has('meetily-hb'))await chrome.alarms.onAlarm.listeners[0]({name:'meetily-hb'})}};
}
for(const provider of ['meet','teams','zoom'])test(provider+' join, idle leave and open tab never resurrect',async()=>{const h=await harness();await h.sensor(provider,false);h.advance(10000);await h.sensor(provider,false);assert.equal(h.calls.filter(x=>x==='start').length,0);await h.sensor(provider);h.advance(3100);await h.sensor(provider);assert.equal(h.recording,true);await h.sensor(provider,false);h.advance(8100);await h.sensor(provider,false);assert.equal(h.recording,false);h.advance(60000);await h.sensor(provider,false);await h.alarm();assert.equal(h.calls.filter(x=>x==='start').length,1)});
test('failed start never displays REC and retries only affirmative fresh evidence',async()=>{const h=await harness();h.failStart=true;await h.sensor();h.advance(3100);await h.sensor();assert.notEqual(h.badge,'REC');h.failStart=false;h.advance(31000);await h.alarm();assert.equal(h.recording,true)});
test('manual stop suppresses still joined tab, rearms only dark/new join',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.run('forceStop()');h.advance(60000);await h.sensor();await h.alarm();assert.equal(h.recording,false);await h.sensor('meet',false);h.advance(8100);await h.sensor('meet',false);await h.sensor();h.advance(3100);await h.sensor();assert.equal(h.recording,true)});
test('failed stop persists retry intent and blocks starts',async()=>{const h=await harness();await h.run('forceStart()');h.failStop=true;await h.run('forceStop()');assert.equal(h.session.recordingControl.pendingStop,true);const r=await h.run('forceStart()');assert.equal(r.ok,false);h.failStop=false;h.advance(31000);await h.alarm();assert.equal(h.recording,false);assert.equal(h.session.recordingControl.pendingStop,false)});
test('stale MV3 restoration cannot REC/start from idle beacon',async()=>{const h=await harness({tabsState:[[1,{inMeeting:true,meetingUrl:true,platform:'meet',lastBeacon:100000}]],recordingControl:{serverAcknowledged:true,sessionId:'restored-id'},resurrectArmed:true});await h.sensor('meet',false);await h.alarm();assert.equal(h.recording,false);assert.notEqual(h.badge,'REC');assert.equal(h.calls.includes('start'),false)});
test('manual ownership survives restart and is reconciled live',async()=>{const h=await harness({recordingControl:{forcedActive:true,serverAcknowledged:true,sessionId:'restored-id'}});h.recording=true;await h.alarm();assert.equal(h.badge,'REC');assert.equal(h.calls.includes('heartbeat'),true)});
test('app explicit stop not interpreted as engine-recovery permission',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.recording=false;await h.alarm();h.advance(60000);await h.sensor();await h.alarm();assert.equal(h.recording,false);assert.equal(h.calls.filter(x=>x==='start').length,1)});
test('duplicate concurrent starts serialize to one native request',async()=>{const h=await harness();await h.run('Promise.all([forceStart(),forceStart(),forceStart()])');assert.equal(h.calls.filter(x=>x==='start').length,1)});
test('concurrent stop requests collapse after successful stop',async()=>{const h=await harness();await h.run('forceStart()');await h.run('Promise.all([stopMeeting(),stopMeeting(),stopMeeting()])');assert.equal(h.calls.filter(x=>x==='stop').length,1)});
test('affirmative signal expiry stops despite idle traffic',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.advance(241000);await h.alarm();assert.equal(h.recording,false)});

test('slow stop holds ownership transition and prevents late concurrent restart',async()=>{
 const h=await harness();await h.run('forceStart()');let release;
 h.stopGate=new Promise(resolve=>{release=resolve});
 const stopped=h.run('forceStop()');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.session.recordingControl.pendingStop,true);
 const start=await h.run('forceStart()');assert.equal(start.ok,false);
 release();await stopped;assert.equal(h.recording,false);
 assert.equal(h.calls.filter(x=>x==='start').length,1);
});
test('lobby media and URL-only force toggle cannot phantom join',async()=>{
 const h=await harness();await h.run('forceEnabled=true');
 await h.sensor('meet',false,{media:true,lobby:true});h.advance(10000);
 await h.sensor('meet',false,{media:true,lobby:true});await h.alarm();
 assert.equal(h.calls.includes('start'),false);
});
test('closed tab stops last automatic recording',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();
 await h.removed();
 assert.equal(h.recording,false);
});

test('native stop intent suppresses REC and heartbeat while finalization still reports recording',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.stopRequested=true;h.stopping=true;await h.alarm();assert.equal(h.badge,'STOP');const starts=h.calls.filter(x=>x==='start').length;h.advance(60000);await h.sensor();await h.alarm();assert.equal(h.calls.filter(x=>x==='start').length,starts);assert.equal(h.calls.filter(x=>x==='heartbeat').length,0)});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const restored=()=>({tabsState:[[1,{inMeeting:true,meetingUrl:true,platform:'meet',url:'https://meet.google.com/abc-defg-hij',lastBeacon:100000,lastAffirmative:100000}]],recordingControl:{serverAcknowledged:true,sessionId:'restored-id'}});
test('delayed heartbeat ping cannot overwrite completed force stop',async()=>{
 const h=await harness();await h.run('forceStart()');let release;h.pingGate=new Promise(r=>release=r);
 const alarm=h.alarm();await tick();await h.run('forceStop()');release();await alarm;
 assert.equal(h.badge,'');assert.equal(h.session.recordingControl.serverAcknowledged,false);assert.equal(h.calls.includes('heartbeat'),false);
});
test('delayed start acknowledgement cannot reacquire ownership after force stop',async()=>{
 const h=await harness();let release;h.startGate=new Promise(r=>release=r);
 const start=h.run('forceStart()');await tick();const stop=h.run('forceStop()');await tick();
 assert.equal(h.session.recordingControl.pendingStop,true);release();const result=await start;await stop;
 assert.equal(result.ok,false);assert.equal(h.recording,false);assert.equal(h.badge,'');assert.equal(h.session.recordingControl.forcedActive,false);
});
test('delayed restoration ping cannot resurrect after force stop',async()=>{
 const h=await harness(restored());h.recording=true;let release;h.pingGate=new Promise(r=>release=r);
 const sensor=h.sensor();await tick();await h.run('forceStop()');release();await sensor;
 assert.equal(await h.run('tabSensors.get(1).inMeeting'),false);assert.equal(h.session.recordingControl.serverAcknowledged,false);
});
test('restored unverified recording stops on actual tab removal',async()=>{
 const h=await harness(restored());h.recording=true;await h.removed();
 assert.equal(h.recording,false);assert.equal(h.calls.includes('start'),false);assert.equal(h.calls.includes('stop'),true);
});
test('restored unverified recording stops on evidence expiry without phantom REC',async()=>{
 const h=await harness(restored());h.recording=true;h.advance(241000);await h.alarm();
 assert.equal(h.recording,false);assert.notEqual(h.badge,'REC');assert.equal(h.calls.includes('start'),false);
});
test('restored closed owner persists pending stop at boot and retries',async()=>{
 const h=await harness(restored(),{tabs:[]});h.recording=true;
 assert.equal(h.session.recordingControl.pendingStop,true);h.advance(31000);await h.alarm();assert.equal(h.recording,false);
});
test('affirmative interruption resets suppression dark interval',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.run('forceStop()');await h.sensor();await h.sensor('meet',false);
 h.advance(7000);await h.sensor();h.advance(2000);await h.sensor('meet',false);
 assert.equal(await h.run('tabSensors.get(1).suppressed'),true);h.advance(8100);await h.sensor('meet',false);
 assert.equal(await h.run('tabSensors.get(1).suppressed'),false);
});
test('large gap between joined samples restarts join confirmation',async()=>{
 const h=await harness();await h.sensor();h.advance(151000);await h.sensor();assert.equal(h.calls.includes('start'),false);
 h.advance(3100);await h.sensor();assert.equal(h.recording,true);
});
test('same-domain SPA meeting-to-lobby navigation stops immediately',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.updated('https://meet.google.com/');
 assert.equal(h.recording,false);assert.equal(await h.run('tabSensors.has(1)'),false);
});
test('sender top URL overrides stale payload and untrusted isTop flag',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();
 await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',isTop:true,joined:true},{tab:{id:1,url:'https://meet.google.com/'},frameId:9})");
 assert.equal(await h.run('tabSensors.get(1).meetingUrl'),false);assert.equal(await h.run('tabSensors.get(1).frames.has(0)'),false);
});
for(const failure of ['storageGet','query'])test('degraded boot '+failure+' remains callable and fail-closed',async()=>{
 const h=await harness(restored(),{[failure]:true});assert.equal(await h.run('degraded'),true);
 const res=await h.run('forceStart()');assert.equal(res.ok,false);assert.equal(h.calls.includes('start'),false);
});
test('queued automatic start rechecks owner identity inside control queue',async()=>{
 const h=await harness();await h.sensor();let release;h.context.gate=new Promise(r=>release=r);
 await h.run('serializeControl(()=>gate); undefined');h.advance(3100);const join=h.sensor();await tick();
 const removed=h.removed();await tick();release();await Promise.all([join,removed]);assert.equal(h.calls.includes('start'),false);
});
test('queued automatic start rechecks freshness inside control queue',async()=>{
 const h=await harness();await h.sensor();let release;h.context.gate=new Promise(r=>release=r);
 await h.run('serializeControl(()=>gate); undefined');h.advance(3100);const join=h.sensor();await tick();
 h.advance(151000);release();await join;assert.equal(h.calls.includes('start'),false);
});
test('pending stop is persisted before last tab ownership is removed',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();
 h.context.observe=h.session;await h.run("const originalPersist=persistTabs; persistTabs=async()=>{if(!tabSensors.has(1) && !observe.recordingControl.pendingStop)throw Error('intent lost');return originalPersist()}");
 await h.removed();assert.equal(h.recording,false);
});

test('failed durable intent blocks transport, retains retry and recovers after storage returns',async()=>{
 const h=await harness(restored(),{storageSet:true});h.recording=true;
 const result=await h.run('forceStop()');assert.equal(result.error,'stop-intent-not-durable');assert.equal(h.recording,true);assert.equal(h.calls.includes('stop'),false);assert.equal(await h.run('pendingStop'),true);h.failures.storageSet=false;h.advance(31000);await h.alarm();assert.equal(h.recording,false);assert.equal(h.session.recordingControl.pendingStop,false);
});
test('restored live lobby URL rejects stale subframe meeting evidence',async()=>{
 const h=await harness(restored(),{tabs:[{id:1,url:'https://meet.google.com/'}]});h.recording=true;
 await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',isTop:false,joined:true},{tab:{id:1},frameId:9})");
 assert.equal(await h.run('tabSensors.get(1).inMeeting'),false);assert.equal(h.calls.includes('ping'),false);assert.equal(h.calls.includes('start'),false);
});

test('pending stop restart does not renew manual ownership and retries finalization',async()=>{
 const h=await harness({recordingControl:{pendingStop:true,stopTarget:'restored-id',forcedActive:true,serverAcknowledged:true,sessionId:'restored-id',retryAfter:0}});h.recording=true;
 await h.alarm();assert.equal(h.recording,false);assert.equal(await h.run('forcedActive'),false);assert.equal(h.calls.includes('heartbeat'),false);assert.equal(h.calls.includes('start'),false);
});
test('restored idle beacons stop unverified native ownership after dark debounce',async()=>{
 const h=await harness(restored());h.recording=true;await h.sensor('meet',false);h.advance(8100);await h.sensor('meet',false);
 assert.equal(h.recording,false);assert.equal(h.calls.includes('start'),false);
});
test('storage-delayed live ping cannot publish REC or heartbeat after completed stop',async()=>{
 const h=await harness();await h.run('forceStart()');let release;h.context.storageGate=new Promise(r=>release=r);
 await h.run('const persistBefore=persistControl; let delayNext=true; persistControl=async()=>{if(delayNext){delayNext=false;await storageGate}return persistBefore()}');
 const alarm=h.alarm();await tick();await h.run('forceStop()');release();await alarm;
 assert.equal(h.badge,'');assert.equal(h.calls.includes('heartbeat'),false);
});
test('restored never-acknowledged failed join can confirm and retry',async()=>{
 const saved=restored();saved.recordingControl.serverAcknowledged=false;
 const h=await harness(saved);await h.sensor();h.advance(3100);await h.sensor();
 assert.equal(h.recording,true);assert.equal(h.calls.filter(x=>x==='start').length,1);
});
test('initial join storage rejection keeps recovery scheduled and retryable',async()=>{
 const h=await harness();await h.sensor();h.failures.storageSet=true;h.advance(3100);await h.sensor().catch(()=>{});
 assert.equal(await h.run('tabSensors.get(1).inMeeting'),true);
 h.failures.storageSet=false;h.advance(31000);await h.alarm();assert.equal(h.recording,true);
});
test('pre-start false ping cannot suppress a successful manual start',async()=>{
 const h=await harness();h.failStart=true;await h.sensor();h.advance(3100);await h.sensor();
 let release;h.pingGate=new Promise(r=>release=r);const alarm=h.alarm();await tick();
 h.failStart=false;await h.run('forceStart()');release();await alarm;
 assert.equal(await h.run('forcedActive'),true);assert.equal(await h.run('serverAcknowledged'),true);
 h.pingGate=null;await h.alarm();assert.equal(h.calls.includes('heartbeat'),true);
});
test('last automatic owner closing during delayed manual start does not queue stop',async()=>{
 const h=await harness();h.failStart=true;await h.sensor();h.advance(3100);await h.sensor();h.failStart=false;
 let release;h.startGate=new Promise(r=>release=r);const start=h.run('forceStart()');await tick();await h.removed();
 assert.equal(h.calls.includes('stop'),false);release();await start;assert.equal(h.recording,true);assert.equal(await h.run('forcedActive'),true);
});
test('concurrent manual starts retain the single acknowledged manual owner',async()=>{
 const h=await harness();await h.run('Promise.all([forceStart(),forceStart(),forceStart()])');
 assert.equal(await h.run('forcedActive'),true);await h.alarm();assert.equal(h.calls.includes('heartbeat'),true);
});
test('failed extension start never adopts unrelated native manual recording',async()=>{
 const h=await harness();h.failStart=true;await h.sensor();h.advance(3100);await h.sensor();h.recording=true;
 await h.alarm();assert.equal(await h.run('serverAcknowledged'),false);await h.removed();
 assert.equal(h.calls.includes('stop'),false);assert.equal(h.recording,true);
});
test('acknowledged live extension renews heartbeats despite ongoing persistence failure',async()=>{
 const h=await harness();await h.run('forceStart()');h.failures.storageSet=true;
 for(let i=0;i<3;i++){h.advance(15000);await h.alarm();}
 assert.equal(h.calls.filter(x=>x==='heartbeat').length,3);assert.equal(h.recording,true);
});
test('unsuccessful manual handoff after last automatic owner closes stops orphan',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();
 let release;h.context.storageGate=new Promise(r=>release=r);
 await h.run('const originalControl=persistControl; let writes=0;persistControl=async()=>{writes++;if(writes===1)await storageGate;return originalControl()}');
 await h.run('startMeeting=async()=>{throw Error("injected failed manual handoff")}');
 const force=h.run('forceStart()');await tick();await h.removed();release();await force.catch(()=>{});
 assert.equal(h.recording,false);assert.equal(h.calls.includes('stop'),true);
});
test('late successful automatic start without any owner queues cleanup',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();await h.removed();release();await join;await tick();await h.run('controlTail');
 assert.equal(h.recording,false);assert.equal(h.calls.includes('stop'),true);
});
test('cached extension acknowledgement cannot force-adopt replacement desktop session',async()=>{
 const h=await harness();await h.run('forceStart()');h.nativeOwner='desktop';
 const result=await h.run('forceStart()');assert.equal(result.ok,false);assert.equal(await h.run('forcedActive'),false);
 await h.alarm();assert.notEqual(h.badge,'REC');await h.run('forceStop()');assert.equal(h.recording,true);
});
test('degraded worker stop cannot stop desktop-owned native recording',async()=>{
 const h=await harness(restored(),{storageGet:true});h.recording=true;h.nativeOwner='desktop';
 await h.run('forceStop()');assert.equal(h.recording,true);
});

for (const removeOwner of [false,true]) test('actual fetch abort retains durable cleanup for '+(removeOwner?'removed':'retained')+' owner',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();assert.ok(h.startSignal);if(removeOwner)await h.removed();
 h.startSignal.testAbort();assert.equal(h.startSignal.aborted,true);await join;await tick();
 assert.equal(h.session.recordingControl.pendingStop,true);assert.ok(h.calls.includes('stop'));assert.notEqual(h.badge,'REC');
 release();await h.nativeSettled();await h.run('controlTail');assert.equal(h.recording,false);assert.equal(h.session.recordingControl.pendingStop,false);
});
for (const removeOwner of [false,true]) test('lost start response after native success cleans '+(removeOwner?'removed':'retained')+' owner',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.lostResponse=true;h.advance(3100);
 const join=h.sensor();await tick();if(removeOwner)await h.removed();release();await join;await tick();await h.run('controlTail');
 assert.ok(h.calls.includes('stop'));assert.equal(h.recording,false);assert.notEqual(h.badge,'REC');
});
test('late automatic success transfers acknowledgement to a fresh second tab',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");h.advance(3100);
 await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");
 await h.removed();release();await join;await h.alarm();
 assert.equal(h.recording,true);assert.equal(await h.run('serverAcknowledged'),true);assert.ok(h.calls.includes('heartbeat'));assert.equal(h.calls.includes('stop'),false);
});
test('stop cancellation reaches native before blocked start responds and duplicates share one flight',async()=>{
 const h=await harness();let release;h.startGate=new Promise(r=>release=r);const start=h.run('forceStart()');await tick();
 const stops=h.run('Promise.all([forceStop(),forceStop(),stopMeeting()])');await tick();
 assert.equal(h.calls.filter(x=>x==='stop').length,1);assert.equal(h.session.recordingControl.pendingStop,true);
 assert.equal((await h.run('forceStart()')).ok,false);release();await Promise.all([start,stops]);assert.equal(h.recording,false);
});

test('fresh tab after completed explicit stop needs dark interval before confirming join',async()=>{
 const h=await harness();await h.run('forceStart()');await h.run('forceStop()');
 const sensor=joined=>h.run(`handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:${joined}},{tab:{id:2},frameId:0})`);
 await sensor(true);h.advance(4000);await sensor(true);assert.equal(h.recording,false);
 await sensor(false);h.advance(8100);await sensor(false);await sensor(true);h.advance(3100);await sensor(true);assert.equal(h.recording,true);
});
test('delayed obsolete targeted stop cannot cancel replacement extension recording',async()=>{
 const h=await harness();await h.run('forceStart()');const old=h.recordingId;
 await h.run('forceStop()');await h.run('forceStart()');assert.notEqual(h.recordingId,old);
 h.context.old=old;await h.run("callServer('/trigger',{action:'stop',platform:'unknown',request_id:old})");assert.equal(h.recording,true);
});
test('replacement extension UUID is not adopted or renewed by old owner',async()=>{
 const h=await harness();await h.run('forceStart()');h.context.old=await h.run('sessionId');
 await h.run("sessionId='obsolete'");await h.alarm();assert.notEqual(h.badge,'REC');assert.equal(h.calls.includes('heartbeat'),false);
});
test('fresh affirmative evidence timestamps persist across worker suspension',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.advance(180000);await h.sensor();
 assert.equal(h.session.tabsState[0][1].lastAffirmative,283100);
 const restoredWorker=await harness(h.session,{now:283100});restoredWorker.recording=true;await restoredWorker.alarm();assert.equal(restoredWorker.calls.includes('stop'),false);
});
test('legacy missing UUID stop never claims native cleanup',async()=>{
 const h=await harness({recordingControl:{serverAcknowledged:true,forcedActive:true}});h.recording=true;
 await h.run('forceStop()');assert.equal(h.recording,true);assert.notEqual(h.badge,'REC');
});

test('unreachable ownership ping retains acknowledged manual owner',async()=>{
 const h=await harness();await h.run('forceStart()');h.pingFail=true;const result=await h.run('forceStart()');
 assert.equal(result.ok,false);assert.equal(await h.run('forcedActive'),true);assert.equal(await h.run('serverAcknowledged'),true);
 h.pingFail=false;await h.alarm();assert.ok(h.calls.includes('heartbeat'));
});
test('body-read abort after native success triggers targeted cleanup',async()=>{
 const h=await harness();h.bodyFail=true;await h.run('forceStart()');await tick();await h.run('controlTail');assert.equal(h.recording,false);assert.ok(h.calls.includes('stop'));
});
test('stale automatic owner with explicit cleanup failure retains stop retry target',async()=>{
 const h=await harness();await h.sensor();h.cleanupFail=true;let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();await h.removed();release();await join;await tick();await h.run('controlTail');assert.ok(h.calls.includes('stop'));assert.equal(h.recording,false);
});
test('restored foreign live session cannot later auto-resurrect without dark transition',async()=>{
 const saved=restored();saved.recordingControl.serverAcknowledged=false;const h=await harness(saved);h.recording=true;h.nativeOwner='desktop';
 await h.sensor();h.recording=false;await h.sensor();h.advance(60000);await h.sensor();await h.alarm();assert.equal(h.calls.includes('start'),false);
});
test('restored fresh timestamp expires under current monotonic wall progression',async()=>{
 const saved=restored();const h=await harness(saved,{now:341001});h.recording=true;await h.alarm();assert.ok(h.calls.includes('stop'));assert.equal(h.recording,false);
});

test('orphan automatic acknowledgement survives failed queued manual handoff target',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();const manual=h.run('forceStart()');await tick();await h.removed();release();await join;await manual;await tick();await h.run('controlTail');
 assert.equal(h.recording,false);assert.ok(h.calls.includes('stop'));
});

test('degraded tab query boot targets known active session and retains retry alarm',async()=>{
 const h=await harness(restored(),{query:true,recording:true});assert.equal(h.recording,false);assert.ok(h.calls.includes('stop'));
});

test('actual stop transport abort preserves target and alarm until retry finalizes',async()=>{
 const h=await harness();await h.run('forceStart()');const id=h.recordingId;let release;h.stopGate=new Promise(r=>release=r);
 const stop=h.run('forceStop()');await tick();h.abortStart();assert.equal(h.stopSignal.aborted,true);await stop;
 assert.equal(h.session.recordingControl.pendingStop,true);assert.equal(h.session.recordingControl.stopTarget,id);assert.equal(h.alarmRegistered,true);
 release();await tick();h.stopGate=null;h.advance(31000);await h.alarm();assert.equal(h.recording,false);assert.equal(h.session.recordingControl.pendingStop,false);
});
test('last automatic tab removal cancels native request before start response',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);
 const join=h.sensor();await tick();await h.removed();await tick();assert.ok(h.calls.includes('stop'));assert.equal(h.session.recordingControl.pendingStop,true);
 release();await join;await tick();await h.run('controlTail');assert.equal(h.recording,false);
});
test('restoration of owner at foreign URL immediately requests targeted cleanup',async()=>{
 const h=await harness(restored(),{recording:true,tabs:[{id:1,url:'https://example.com/'}]});assert.equal(h.session.recordingControl.pendingStop,true);
 h.advance(31000);await h.alarm();assert.equal(h.recording,false);
});
test('dark debounce before late automatic success retains cleanup identity',async()=>{
 const h=await harness();await h.sensor();let release;h.startGate=new Promise(r=>release=r);h.advance(3100);const join=h.sensor();await tick();
 await h.sensor('meet',false);release();await join;await tick();await h.run('controlTail');assert.equal(h.recording,false);assert.ok(h.calls.includes('stop'));
});
test('legacy desktop protocol cannot receive start or stop lifecycle commands',async()=>{
 const h=await harness({}, {legacy:true});assert.equal((await h.run('forceStart()')).ok,false);await h.run('forceStop()');assert.equal(h.calls.includes('start'),false);assert.equal(h.calls.includes('stop'),false);
});
test('interrupted start cleanup identity does not recreate intent on second restart',async()=>{
 const h=await harness({recordingControl:{activeStartId:'restored-id'}},{recording:true});h.advance(31000);await h.alarm();assert.equal(h.session.recordingControl.activeStartId,null);
 const again=await harness(h.session);assert.equal(again.session.recordingControl.pendingStop,false);
});
test('dark suppression evidence gap restarts continuous dark confirmation',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.run('forceStop()');await h.sensor('meet',false);h.advance(120000);await h.sensor('meet',false);await h.sensor();h.advance(3100);await h.sensor();assert.equal(h.recording,false);
});
test('retained acknowledged automatic owner renews through throttled freshness interval',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.advance(160000);await h.alarm();assert.equal(h.badge,'REC');assert.ok(h.calls.includes('heartbeat'));assert.equal(h.recording,true);
});
test('pairing identity mismatch after restart cannot clear old pending cleanup',async()=>{
 const h=await harness({recordingControl:{pendingStop:true,stopTarget:'old',ownerPairing:'different',retryAfter:0}});await h.alarm();assert.equal(h.session.recordingControl.pendingStop,true);assert.equal(h.calls.includes('stop'),false);
});
test('ordinary dark leave completes via alarm without another sensor beacon',async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.sensor('meet',false);h.advance(8100);await h.alarm();assert.equal(h.recording,false);
});

test('cancellation transport waits for durable intent even when bypassing active start',async()=>{
 const h=await harness();let releaseStart,releaseWrite;
 h.startGate=new Promise(r=>releaseStart=r);
 const start=h.run('forceStart()');await tick();
 h.context.writeBarrier=new Promise(r=>releaseWrite=r);
 await h.run('const savedPersist=persistControl; persistControl=async()=>{await writeBarrier; return savedPersist()}');
 const stop=h.run('forceStop()');await tick();
 assert.equal(h.calls.includes('stop'),false);
 releaseWrite();await tick();assert.equal(h.calls.includes('stop'),true);
 assert.equal(h.session.recordingControl.pendingStop,true);
 releaseStart();await Promise.all([start,stop]);assert.equal(h.recording,false);
});
for(const flag of ['disappeared','stop_requested','stopping'])test('second-tab join before alarm respects acknowledged desktop '+flag,async()=>{
 const h=await harness();await h.sensor();h.advance(3100);await h.sensor();
 if(flag==='disappeared')h.recording=false;else if(flag==='stop_requested')h.stopRequested=true;else h.stopping=true;
 await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',isTop:true,joined:true},{tab:{id:2},frameId:0})");h.advance(3100);
 await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',isTop:true,joined:true},{tab:{id:2},frameId:0})");
 assert.equal(h.calls.filter(x=>x==='start').length,1);assert.equal(await h.run('stopSuppressed'),true);assert.equal(await h.run('[...tabSensors.values()].every(t=>t.suppressed)'),true);
});
test('completed stop retires pairing snapshots across pairing change and worker reboot',async()=>{
 const h=await harness();await h.run('forceStart()');await h.run('forceStop()');
 assert.equal(h.session.recordingControl.ownerPairing,null);assert.equal(await h.run('ownerConnection'),null);
 await h.run("chrome.storage.local.set({token:'changed',port:7799})");assert.equal((await h.run('forceStop()')).ok,true);assert.equal((await h.run('forceStart()')).ok,true);
 await h.run('forceStop()');const reboot=await harness(h.session);await reboot.run("chrome.storage.local.set({token:'again',port:7798})");assert.equal((await reboot.run('forceStop()')).ok,true);assert.equal((await reboot.run('forceStart()')).ok,true);
});

test('cold changed pairing cannot renew matching native UUID and keeps old cleanup target',async()=>{
 const h=await harness();await h.run('forceStart()');const saved=structuredClone(h.session);const reboot=await harness(saved,{recording:true});
 await reboot.run("chrome.storage.local.set({token:'new-token'})");await tick();await reboot.alarm();
 assert.equal(reboot.calls.includes('heartbeat'),false);assert.equal(await reboot.run('pendingStop'),true);assert.equal(reboot.session.recordingControl.stopTarget,h.recordingId);
});
for(const phase of ['initializing','acknowledged'])test('real pairing storage event cancels '+phase+' owner',async()=>{
 const h=await harness();let release;if(phase==='initializing')h.startGate=new Promise(r=>release=r);
 const started=h.run('forceStart()');await tick();if(phase==='acknowledged')await started;
 await h.run("chrome.storage.local.set({token:'rotated',port:7790})");await tick();
 if(phase==='initializing')assert.equal(await h.run('pendingStop'),true);else assert.equal(h.recording,false);
 if(release)release();await started;await tick();await h.run('controlTail');assert.equal(h.recording,false);assert.equal(h.calls.includes('heartbeat'),false);
});

test('foreign owner suppresses all tabs through disappearance without dark rearm',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();h.nativeOwner='desktop';await h.alarm();await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");h.advance(3100);await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");h.recording=false;h.advance(31000);await h.alarm();assert.equal(h.calls.filter(x=>x==='start').length,1)});
test('runtime pairing cleanup uses original authenticated destination',async()=>{const h=await harness();await h.run('forceStart()');await h.run("chrome.storage.local.set({port:7799,token:'replacement'})");await tick();await h.run('controlTail');const stops=h.transports.filter(t=>t.body?.action==='stop');assert.ok(stops.length);for(const t of stops){assert.equal(new URL(t.url).port,'7788');assert.equal(t.authorization,'Bearer test')}});
test('unreadable durable control survives boot failure then retries original UUID',async()=>{const saved=restored();saved.recordingControl.pendingStop=true;saved.recordingControl.stopTarget='restored-id';const h=await harness(saved,{storageGet:true});assert.equal(h.session.recordingControl.stopTarget,'restored-id');assert.equal(h.calls.includes('stop'),false);h.recording=true;h.failures.storageGet=false;h.advance(31000);await h.alarm();assert.equal(h.recording,false)});

test('explicit Stop while durable control unreadable preserves saved UUID and sends no transport',async()=>{const saved=restored();saved.recordingControl.stopTarget='restored-id';const h=await harness(saved,{storageGet:true});await h.run('forceStop()');assert.equal(h.session.recordingControl.stopTarget,'restored-id');assert.equal(h.session.recordingControl.sessionId,'restored-id');assert.equal(h.calls.includes('stop'),false);assert.equal(h.alarmRegistered,true)});
test('transient tab inventory failure recovers in same worker',async()=>{const h=await harness(restored(),{query:true});h.failures.query=false;h.advance(31000);await h.alarm();assert.equal(await h.run('degraded'),false);assert.equal((await h.run('forceStart()')).ok,true)});
test('foreign restored owner suppresses every restored tab before disappearance',async()=>{const saved=restored();saved.tabsState.push([2,{...saved.tabsState[0][1]}]);const h=await harness(saved,{recording:true,tabs:[{id:1,url:'https://meet.google.com/abc-defg-hij'},{id:2,url:'https://meet.google.com/abc-defg-hij'}]});h.nativeOwner='desktop';await h.sensor();h.recording=false;await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");h.advance(3100);await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:2},frameId:0})");await h.alarm();assert.equal(h.calls.includes('start'),false);assert.equal(await h.run('[...tabSensors.values()].every(t=>t.suppressed)'),true)});

test('unreadable explicit Stop hydrates original owner and remains dominant after read recovery',async()=>{const h=await harness({recordingControl:{serverAcknowledged:true,forcedActive:true,sessionId:'restored-id',pendingStop:false}},{storageGet:true});h.recording=true;await h.run('forceStop()');h.failures.storageGet=false;h.advance(31000);await h.alarm();assert.equal(h.recording,false);assert.equal(h.calls.includes('heartbeat'),false)});
test('old document unload cannot delete replacement frame evidence',async()=>{const h=await harness();h.currentDocuments.set('1:0','new');await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'new'})");h.advance(3100);await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'new'})");await h.run("for(const listener of chrome.runtime.onMessage.listeners)listener({kind:'FRAME_GONE'},{tab:{id:1},frameId:0,documentId:'old'},()=>{})");await tick();h.advance(8100);await h.alarm();assert.equal(h.recording,true);assert.equal(await h.run("tabSensors.get(1).frames.get(0).documentId"),'new')});

test('pairing change during automatic recording cannot rearm same joined meeting on replacement',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.run("chrome.storage.local.set({port:7799,token:'replacement'})");await tick();await h.run('controlTail');h.advance(31000);await h.sensor();await h.alarm();assert.equal(h.calls.filter(x=>x==='start').length,1);assert.equal(h.recording,false);assert.equal(await h.run('stopSuppressed'),true)});

test('old SENSOR cannot replace authoritative new document dark evidence',async()=>{const h=await harness();h.currentDocuments.set('1:0','new');await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:false},{tab:{id:1},frameId:0,documentId:'new'})");await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'old'})");h.advance(3100);await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'old'})");assert.equal(h.calls.includes('start'),false);assert.equal(await h.run('tabSensors.get(1).frames.get(0).joined'),false)});
test('same URL replacement needs independent join confirmation',async()=>{const h=await harness();h.currentDocuments.set('1:0','old');await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'old'})");h.advance(3100);h.currentDocuments.set('1:0','new');await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'new'})");assert.equal(h.calls.includes('start'),false);h.advance(3100);await h.run("handleSensor({platform:'meet',url:'https://meet.google.com/abc-defg-hij',joined:true},{tab:{id:1},frameId:0,documentId:'new'})");assert.equal(h.recording,true)});

test('navigation commit without replacement beacon persists disappearance across restart',async()=>{const h=await harness();await h.sensor();h.advance(3100);await h.sensor();await h.commit();assert.ok(h.session.tabsState[0][1].frameGoneAt);const reboot=await harness(h.session,{recording:true,now:103100});reboot.advance(8100);await reboot.alarm();assert.equal(reboot.recording,false)});
