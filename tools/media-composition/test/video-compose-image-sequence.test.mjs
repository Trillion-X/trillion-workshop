import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {linkSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const epoch=mkdtempSync(join(tmpdir(),'frames-'));
const colors=join(epoch,'colors');mkdirSync(colors);
// Three genuinely different source pictures make a lost tail observable; frame
// count alone would accept padding that merely repeats the preceding picture.
const colorPixels=[[0,0,255],[255,0,0],[0,255,0]].map(rgb=>{
 const pixels=Buffer.alloc(64*36*3);for(let at=0;at<pixels.length;at+=3)pixels.set(rgb,at);return pixels;
});
execFileSync('ffmpeg',['-v','error','-f','rawvideo','-pixel_format','rgb24','-video_size','64x36','-framerate','1','-i','pipe:0','-frames:v','3',join(colors,'%06d.png')],{input:Buffer.concat(colorPixels)});

for(const count of [574,420,456])test(`declared30fps image sequence retains all${count} real frames and its distinct tail`,{timeout:30000},t=>{
 const dir=join(epoch,String(count)),frames=join(dir,'frames'),work=join(dir,'work');mkdirSync(dir);mkdirSync(frames);mkdirSync(work);
 for(let index=0;index<count;index++)linkSync(join(colors,`${String(index===0?1:index===count-1?3:2).padStart(6,'0')}.png`),join(frames,`${String(index).padStart(6,'0')}.png`));
 const duration=count/30,edl={encode:{width:64,height:36,fps:30,crf:8,preset:'ultrafast'},spine:{segments:[{id:'frames',kind:'clip',source:join(frames,'%06d.png'),source_frame_rate:30,in:0,out:duration,silent_audio:true}]}};
 const edlPath=join(dir,'edl.json'),video=join(dir,'composed.mp4');writeFileSync(edlPath,JSON.stringify(edl,null,2)+'\n');
 const render=spawnSync(process.execPath,[join(root,'do-work/video-compose.mjs'),'--edl',edlPath,'--out',video,'--workdir',work],{cwd:root,encoding:'utf8',timeout:30000});
 assert.equal(render.status,0,render.stderr||render.error?.message);
 const{stdout,stderr}=render;
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames,duration,r_frame_rate','-of','json',video],{encoding:'utf8'}));
 const decoded=execFileSync('ffmpeg',['-v','error','-i',video,'-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);
 const result={count,source_duration:duration,probe,decoded_frames:decoded.length/3,first:[...decoded.subarray(0,3)],last:[...decoded.subarray(-3)],stdout,stderr};
 writeFileSync(join(dir,'readback.json'),JSON.stringify(result,null,2)+'\n');
 assert.equal(Number(probe.streams[0].nb_frames),count);
 assert.equal(decoded.length,count*3,'every declared real frame must decode');
 assert.equal(probe.streams[0].r_frame_rate,'30/1');
 assert.ok(Math.abs(Number(probe.streams[0].duration)-duration)<.000001);
 assert.ok(result.first[2]>220&&result.first[0]<30&&result.first[1]<30,'first actual source frame is blue');
 assert.ok(result.last[1]>220&&result.last[0]<30&&result.last[2]<30,'last actual source frame is green, not a repeated preceding red frame');
 t.diagnostic(join(dir,'readback.json'));
});
