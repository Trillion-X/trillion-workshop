import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOwnedProcess} from '../../process-session/do-work/run-owned-process.mjs';
import {trackToReframe} from './auto-reframe.mjs';

const detector=fileURLToPath(new URL('../../motion-analysis/do-work/process-scripts/reel/detect_subject_track.py',import.meta.url));

/** Strict semantic producer boundary. Confidence denotes detector tier, not
 * calibrated probability or identity continuity. Center is explicit fallback. */
export function semanticTrackToReframe(result,options={}){
  if(result?.kind!=='subject_track.v1'||!Array.isArray(result.track)||!result.track.length)throw new Error('Subject detector returned no samples.');
  let previous=-Infinity,detected=0;
  const source=result.track.map(p=>{
    if(!p||![p.t,p.cx,p.cy,p.confidence].every(Number.isFinite)||p.t<0||p.t<=previous||p.cx<0||p.cx>1||p.cy<0||p.cy>1||p.confidence<0||p.confidence>1||!['face','person','center'].includes(p.method))throw new Error('Subject detector returned invalid or non-semantic samples.');
    previous=p.t;if(p.method!=='center')detected++;
    return {t:p.t,x:p.cx,y:p.cy};
  });
  return {reframe:trackToReframe(source,{...options,smooth:false}),support:{detector:result.detector,semantic_samples:detected,total_samples:source.length,fallback_samples:source.length-detected,subject_detected:detected>0,identity_tracking_verified:false},samples:result.track};
}

/** Local, cancellable adapter over the existing perception owner. Never
 * downloads models. Manual reframe DATA bypasses inference entirely. */
export async function semanticReframe(file,{python='python3',fps=4,alpha=.35,start=0,end,signal,timeoutMs=120000,manualReframe,...options}={}){
  signal?.throwIfAborted();
  if(manualReframe)return {reframe:structuredClone(manualReframe),support:{manual_override:true}};
  if(typeof file!=='string'||!path.isAbsolute(file))throw new TypeError('Provide an absolute local video path.');
  if(!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start)throw new TypeError('Provide a finite increasing source start/end range.');
  if(!Number.isFinite(fps)||fps<=0||fps>60||!Number.isFinite(alpha)||alpha<=0||alpha>1)throw new TypeError('Invalid tracking sample rate or smoothing.');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'semantic-reframe-'));
  try{
    const output=path.join(root,'track.json');
    // Haar ships with OpenCV. Optional DNN models must not be inherited from
    // unrelated environment configuration; this adapter claims face detection.
    const env={...process.env};delete env.SUBJECT_DNN_PROTO;delete env.SUBJECT_DNN_MODEL;
    await runOwnedProcess(python,[detector,'--clip',file,'--out',output,'--fps',String(fps),'--smooth',String(alpha),'--start',String(start),'--end',String(end),'--semantic-only'],{signal,timeoutMs,env});
    signal?.throwIfAborted();
    const result=JSON.parse(await fs.readFile(output,'utf8'));
    if(result.source_range?.start!==start||result.source_range?.end!==end||result.track?.some(p=>p.t>=end-start))throw new Error('Subject detector returned a different source range.');
    return semanticTrackToReframe(result,options);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
