import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Diagnostic fields only: no command, environment, stderr, stack or arbitrary
// error message. Reading data descriptors avoids invoking hostile getters.
const own = (value, key) => {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
export function describeOwnedProcessFailure(error) {
  const chain=[], seen=new Set(); let current=error;
  for(let depth=0; current && depth<4; depth++){
    if(seen.has(current)){chain.push({cycle:true});break;}
    seen.add(current);
    const code=own(current,'code'),errno=own(current,'errno'),syscall=own(current,'syscall');
    chain.push({
      ...(typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?{code}:{}),
      ...(Number.isSafeInteger(errno)?{errno}:{}),
      ...(typeof syscall==='string'&&/^[a-z_]{1,32}$/.test(syscall)?{syscall}:{}),
    });
    current=own(current,'cause');
  }
  const detail=own(error,'cleanupDiagnostics'),cleanup={};
  const reason=own(detail,'reason');
  if(['unexpected-probe-error','exhausted-wait'].includes(reason))cleanup.reason=reason;
  for(const key of ['group_id','probe_unix_ms','wait_started_unix_ms','wait_elapsed_ms']){
    const value=own(detail,key);if(Number.isSafeInteger(value)&&value>=0)cleanup[key]=value;
  }
  const termination=own(error,'ownerTermination'),owner_termination={};
  for(const key of ['worker_exit_code','supervisor_exit_code']){
    const value=own(termination,key);if(value===null||Number.isSafeInteger(value))owner_termination[key]=value;
  }
  const signal=own(termination,'supervisor_exit_signal');
  if(signal===null||(typeof signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(signal)))owner_termination.supervisor_exit_signal=signal;
  return {schema:'process-session.cleanup-failure',process_stopped:own(error,'processStopped')===false?false:null,cleanup,causes:chain,cause_chain_truncated:!!current&&!seen.has(current),owner_termination};
}

export function groupCleanupError(reason,groupId,probeAt,waitStartedAt,cause) {
  return Object.assign(new Error('Could not confirm that the process group stopped.',{cause}),{
    processStopped:false,
    cleanupDiagnostics:{reason,group_id:groupId,probe_unix_ms:probeAt,
      wait_started_unix_ms:waitStartedAt??null,
      wait_elapsed_ms:waitStartedAt===undefined?null:Math.max(0,probeAt-waitStartedAt)},
  });
}

// Local embedding adapter for a caller-owned subprocess lifetime. No shell,
// durable queue, clock or command discovery is owned here.
export function runOwnedProcess(command,args,{signal,timeoutMs=600000,startupTimeoutMs=30000,maxBytes=4*1024*1024,env=process.env,graceMs=500,cwd,input,onStage,onStart,onStdout,onStderr,onTermination}={}){
  signal?.throwIfAborted();
  if(input!==undefined&&(!input||['pipe','unpipe','once','removeListener'].some(method=>typeof input[method]!=='function')))throw new Error('Process input must be a readable stream.');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./owned-process-lifetime.mjs',import.meta.url)),JSON.stringify([command,...args])],{env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe','ipc',input?'pipe':'ignore']});
    let phase='supervisor-created';
    const stage=value=>{phase=value;try{onStage?.(value);}catch{}};
    let stdout='',stderr='',size=0,failure,supervisorExited=false,closed=false,code,closeSignal,reportedCode,terminationDone=true,timeout,startupTimeout,escalation,groupWait,groupWaitStart;
    // Once the direct supervisor is reaped its numeric group ID may be reused.
    // Only its own lifetime owner signals that group during normal shutdown;
    // Inherited pipes may delay close after exit. Exit ends signaling authority;
    // close remains the separate output-completion boundary.
    const kill=which=>{if(supervisorExited||closed)return;try{if(process.platform==='win32')child.kill(which);else if(child.pid)process.kill(-child.pid,which);}catch(e){if(e.code!=='ESRCH')failure??=e;}};
    const exit=()=>kill('SIGKILL');process.once('exit',exit);
    const finish=()=>{
      if(!closed||!terminationDone||groupWait)return;
      if(process.platform!=='win32'&&child.pid){
        const probeAt=Date.now();
        let probeError;
        try{process.kill(-child.pid,0);}catch(error){probeError=error;}
        if(!probeError||probeError.code==='EPERM'){
          // EPERM is not absence. Darwin also returns it for zombie-only
          // groups; observe within the unchanged deadline without signaling.
          groupWaitStart??=Date.now();
          if(Date.now()-groupWaitStart<2000){groupWait=setTimeout(()=>{groupWait=null;finish();},10);return;}
          failure=groupCleanupError('exhausted-wait',child.pid,probeAt,groupWaitStart,probeError??failure);
        }else if(probeError.code!=='ESRCH'){
          failure=groupCleanupError('unexpected-probe-error',child.pid,probeAt,groupWaitStart,probeError);
        }
      }
      clearTimeout(timeout);clearTimeout(startupTimeout);clearTimeout(escalation);input?.unpipe(child.stdio[4]);input?.removeListener('error',inputError);child.stdio[4]?.destroy();child.stdin.destroy();process.removeListener('exit',exit);signal?.removeEventListener('abort',abort);
      const termination={worker_exit_code:reportedCode??null,supervisor_exit_code:code??null,supervisor_exit_signal:closeSignal??null};
      if((code!==null&&code!==0)||(closeSignal!=null&&closeSignal!=='SIGKILL'))failure??=Object.assign(new Error('The process lifetime supervisor failed.'),{code:'SUPERVISOR_EXIT_FAILED'});
      if(!failure&&(reportedCode??code)!==0)failure=new Error(stderr.trim()||`Process exited with code ${reportedCode??code}.`);
      try{onTermination?.(termination,{processGroupStopped:own(failure,'processStopped')!==false});}catch{}
      if(failure){try{Object.defineProperty(failure,'ownerTermination',{value:termination,enumerable:true,configurable:true});}catch{}reject(failure);}else resolve(stdout);
    };
    const stop=error=>{if(failure)return;failure=error;terminationDone=false;kill('SIGTERM');escalation=setTimeout(()=>{kill('SIGKILL');terminationDone=true;finish();},graceMs);};
    const abort=()=>stop(signal.reason instanceof Error?signal.reason:new Error('Work was cancelled.'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    // Bind ownership before the supervisor can start a writer. Async admission
    // registration is part of that handshake, never an unawaited side effect.
    const inputError=error=>stop(error);
    input?.once('error',inputError);
    child.stdio[4]?.on('error',error=>{input?.unpipe(child.stdio[4]);if(error.code!=='EPIPE'&&!closed)stop(error);});
    Promise.resolve().then(()=>{stage('registering');return onStart?.({supervisorPid:child.pid,groupId:process.platform==='win32'?null:child.pid});}).then(()=>{
      stage('registered');
      if(!failure&&!supervisorExited&&!closed){
        input?.pipe(child.stdio[4]);
        // IPC accepting bytes does not establish that the executable reached its owner.
        child.send({start:true,cwd,hasInput:Boolean(input)},error=>{if(error)stop(error);else stage('start-sent');});
      }
    }).catch(error=>stop(error));
    startupTimeout=setTimeout(()=>stop(Object.assign(new Error('The process ownership handshake exceeded its startup deadline.'),{ownedProcessStage:phase})),startupTimeoutMs);
    timeout=setTimeout(()=>stop(Object.assign(new Error('The process exceeded its time limit.'),{ownedProcessStage:phase})),timeoutMs);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const read=(value,errorStream)=>{size+=Buffer.byteLength(value);if(size>maxBytes){stop(new Error('The process returned too much output.'));return;}if(errorStream){stderr+=value;if(!failure&&onStderr)try{onStderr(value);}catch(error){stop(error);}}else{stdout+=value;if(!failure&&onStdout)try{onStdout(value);}catch(error){stop(error);}}};
    child.stdout.on('data',value=>read(value,false));child.stderr.on('data',value=>read(value,true));
    child.stdin.on('error',()=>{});
    child.on('message',message=>{
      if(message?.kind==='worker-started'&&Number.isInteger(message.pid)&&message.pid>0){clearTimeout(startupTimeout);stage('worker-started');}
      if(message&&Number.isInteger(message.code)){reportedCode=message.code;stage('worker-result');}
    });
    child.on('exit',()=>{supervisorExited=true;stage('supervisor-exited');});
    child.on('error',error=>{failure??=error;});child.on('close',(value,signal)=>{closed=true;code=value;closeSignal=signal;stage('output-closed');finish();});
  });
}
