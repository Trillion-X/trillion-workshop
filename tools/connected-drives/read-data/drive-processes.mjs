// tools/connected-drives/read-data/drive-processes.mjs
//
// Only kernel-reported open files establish drive use. Command arguments can
// mention a mount while merely requesting its ejection or displaying its name.
export function driveFileHolders(output,processes=[],ownPid=process.pid){
  const holders=new Map();let pid;
  for(const line of String(output).split('\n')){
    if(line.startsWith('p')){pid=Number(line.slice(1));if(Number.isInteger(pid)&&pid>1&&pid!==ownPid)holders.set(pid,{pid,name:'Running task',command:''});}
    else if(line.startsWith('c')&&holders.has(pid))holders.get(pid).name=line.slice(1)||'Running task';
    else if(line.startsWith('n')&&holders.has(pid))holders.get(pid).command=line.slice(1);
  }
  for(const row of processes)if(holders.has(row.pid))holders.set(row.pid,{...holders.get(row.pid),...row});
  return [...holders.values()];
}
