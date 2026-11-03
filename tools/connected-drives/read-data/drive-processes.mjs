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

// A process's name in words a person recognises. `ps` cuts the program column to 16 characters unless it is the last
// column, so the program and the full command line are read as two lists (each with its own column last) and joined
// by pid. A program that runs a script (node, python, a shell) is named by that script, which is what the person
// started; the script's path may hold spaces, so it is the shortest run from a `/` to a script file's ending.
const SCRIPT_PATH=/(?:^|\s)(\/.*?\.(?:mjs|cjs|js|ts|py|rb|pl|sh))(?=\s|$)/;
export function readProcessRows(commandsOutput,programsOutput){
  const rows=text=>new Map(String(text).split('\n').map(line=>line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean).map(match=>[Number(match[1]),match[2]]));
  const programs=rows(programsOutput);
  return [...rows(commandsOutput)].map(([pid,command])=>{
    const program=programs.get(pid)||command;
    const script=command.slice(command.startsWith(program)?program.length:0).match(SCRIPT_PATH)?.[1];
    const name=(script||program).split('/').pop()||'Running task';
    return {pid,name,program,command,alive:true};
  });
}
