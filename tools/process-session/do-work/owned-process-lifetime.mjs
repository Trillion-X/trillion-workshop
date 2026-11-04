import {spawn} from 'node:child_process';

// The embedding process keeps stdin open. Kernel pipe closure ends this process
// group even if its parent was killed without running a JavaScript exit hook.
// This is event-driven ownership, not a watcher or background scheduler.
const stop=()=>{
  if(process.platform!=='win32'){try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}}
  else{child?.kill('SIGKILL');process.exit(1);}
};
let child;
// Group SIGTERM also reaches this supervisor. Keep its incarnation alive until
// the worker exits or the parent's existing grace-period SIGKILL ends the group.
// Otherwise an ignoring worker outlives the signaling authority.
process.on('SIGTERM',()=>{});
process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();
const report=(code,signal)=>{if(process.send)process.send({code,signal},()=>stop());else stop();};
const start=message=>{try{
  const [command,...args]=JSON.parse(process.argv[2]);
  child=spawn(command,args,{stdio:[message.hasInput?4:'ignore','inherit','inherit'],env:process.env,...(message.cwd===undefined?{}:{cwd:message.cwd})});
  child.once('spawn',()=>{if(process.send)process.send({kind:'worker-started',pid:child.pid});});
  child.once('error',error=>{process.stderr.write(error.message);report(1,null);});
  child.once('exit',(code,signal)=>{
    // Kill descendants before reporting the leader's actual result. The parent
    // receives this status over the separate IPC channel, never from stdout.
    report(code,signal);
  });
}catch(error){process.stderr.write(error.message);process.exit(1);}};
// The embedding owner binds this supervisor's process group to its resource
// record before sending start. Parent death before that handshake closes stdin,
// so the empty group stops without ever starting a workspace writer.
process.once('message',message=>{
  if(message?.start===true&&(message.cwd===undefined||typeof message.cwd==='string')&&(message.hasInput===undefined||typeof message.hasInput==='boolean'))start(message);
  else{process.stderr.write('Process lifetime start was not authorized.');process.exit(1);}
});
