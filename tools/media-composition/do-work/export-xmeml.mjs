import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {visualOverlayOrder} from './visual-overlay-order.mjs';

// A source is named as the editor's computer names it: a POSIX path (Mac, Linux) or a Windows drive path (a mapped
// network drive such as Z:\Footage\clip.mp4). Each form keeps its own separators in the name and the file address.
const windowsPath=file=>/^[A-Za-z]:[\\/]/.test(file);
const baseName=file=>file.split(windowsPath(file)?/[\\/]/:'/').pop();
const fileUrl=file=>windowsPath(file)?`file://localhost/${file.slice(0,2)}${file.slice(2).replace(/\\/g,'/').split('/').map(encodeURIComponent).join('/')}`:pathToFileURL(file).href;

const escape=value=>String(value).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
function rate(value){
  const fps=typeof value==='object'&&value?value.numerator/value.denominator:Number(value);
  if(!Number.isFinite(fps)||fps<1||fps>120)throw new Error('Use a supported sequence frame rate.');
  if(Number.isInteger(fps))return {fps,timebase:fps,ntsc:false};
  for(const nominal of [24,30,60,120])if(Math.abs(fps-nominal*1000/1001)<.001)return {fps:nominal*1000/1001,timebase:nominal,ntsc:true};
  throw new Error('This fractional frame rate cannot be represented by XMEML.');
}
const rateXml=r=>`<rate><timebase>${r.timebase}</timebase><ntsc>${r.ntsc?'TRUE':'FALSE'}</ntsc></rate>`;
const dimension=n=>Number.isInteger(n)&&n>0&&n<=16384;
function audioGain(value,fallback){
  const gain=value??fallback;
  if(!Number.isFinite(gain)||gain<0)throw new Error('Use a finite nonnegative audio volume.');
  return gain;
}
// XMEML Audio Levels/Level is linear gain, not dB. Preserve zero explicitly.
const gainXml=gain=>`<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${gain}</value></parameter></effect></filter>`;

/** Translate the existing clip spine into a private editable XMEML sequence.
 * sourceMetadata is optional, keyed by absolute source path, with fps,
 * duration, width, height and has_audio. It must come from actual media probes.
 * This pure adapter never probes files or claims editor import verification.
 */
export function exportXmeml({title,edl,sourceMetadata={}}){
  if(typeof title!=='string'||!title.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title))throw new Error('Name the sequence.');
  const sequenceRate=rate(edl?.encode?.fps),width=edl?.encode?.width,height=edl?.encode?.height;
  if(!dimension(width)||!dimension(height))throw new Error('Use valid sequence dimensions.');
  const segments=edl?.spine?.segments;
  if(!Array.isArray(segments)||!segments.length||segments.length>10000)throw new Error('Choose a nonempty clip sequence.');
  const limitations=[];
  const note=(code,details)=>limitations.push({code,...details});
  const timeline=[],files=new Map();let elapsed=0;
  function source(file,audioOnly=false){
    if(typeof file!=='string'||!(path.posix.isAbsolute(file)||windowsPath(file))||/[\x00-\x1f]/.test(file))throw new Error('XMEML needs resolved absolute source files.');
    if(files.has(file))return files.get(file);
    const metadata=sourceMetadata[file]||{},id='source-'+(files.size+1),sourceRate=metadata.fps===undefined?sequenceRate:rate(metadata.fps);
    if(metadata.fps===undefined)note('source-rate-assumed',{source:file,assumed_fps:sequenceRate.fps});
    const item={file,id,metadata,rate:sourceRate,audioOnly};files.set(file,item);return item;
  }
  for(const [index,segment] of segments.entries()){
    if(segment.kind!=='clip'||!Number.isFinite(segment.in)||!Number.isFinite(segment.out)||segment.in<0||segment.out<=segment.in)throw new Error('XMEML supports forward clip cuts with valid source ranges.');
    if(['speed','reverse','loop_count','loop_boomerang','time_remap','speed_ramp'].some(key=>segment[key]!==undefined))throw new Error('Retimed or repeated clips need a verified export adapter before their timeline can be preserved.');
    const media=source(segment.source);
    if(media.metadata.has_audio===undefined)note('source-audio-assumed',{source:segment.source});
    if(Number.isFinite(media.metadata.duration)&&segment.out>media.metadata.duration+.000001)throw new Error('A cut extends past its source duration.');
    const start=Math.round(elapsed*sequenceRate.fps);elapsed+=segment.out-segment.in;const end=Math.round(elapsed*sequenceRate.fps);
    // Premiere interprets clipitem in/out in the sequence timebase, even when
    // file metadata reports a different native source rate. Keep that native
    // rate on <file>, and describe edit positions in the sequence timebase.
    const inFrame=Math.round(segment.in*sequenceRate.fps),outFrame=Math.round(segment.out*sequenceRate.fps);
    if(end<=start||outFrame<=inFrame)throw new Error('A cut is shorter than one exportable frame.');
    const unsupported=Object.keys(segment).filter(key=>!['kind','id','source','in','out'].includes(key));
    if(unsupported.length)note('clip-transforms-not-translated',{clip_id:segment.id??index,fields:unsupported});
    timeline.push({id:'clip-'+(index+1),media,start,end,inFrame,outFrame});
  }
  if(edl.subtitles)note('captions-not-translated',{fields:Object.keys(edl.subtitles)});
  const extra=Object.keys(edl).filter(key=>!['spine','encode','audio_graph','audio','subtitles','video_overlays','image_overlays'].includes(key));
  if(extra.length)note('composition-fields-not-translated',{fields:extra});
  const spineExtra=Object.keys(edl.spine).filter(key=>key!=='segments');if(spineExtra.length)note('spine-fields-not-translated',{fields:spineExtra});
  const encodeExtra=Object.keys(edl.encode).filter(key=>!['width','height','fps'].includes(key));if(encodeExtra.length)note('render-settings-not-translated',{fields:encodeExtra});
  const totalFrames=Math.round(elapsed*sequenceRate.fps),audio=edl.audio_graph||edl.audio||{};
  let music=null;
  if(audio.music_bed){
    const bed=audio.music_bed,media=source(bed.artifact,true),from=bed.trim?.[0]??0;
    let to=Math.min(bed.trim?.[1]??elapsed,from+elapsed);
    if(Number.isFinite(media.metadata.duration))to=Math.min(to,media.metadata.duration);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from)throw new Error('Use a valid music source range.');
    const end=Math.min(totalFrames,Math.round((to-from)*sequenceRate.fps));
    if(end<1)throw new Error('Music is shorter than one exportable frame.');
    music={id:'music-1',media,start:0,end,inFrame:Math.round(from*sequenceRate.fps),outFrame:Math.round(to*sequenceRate.fps),gain:audioGain(bed.volume,.9)};
    // The renderer applies default fades/gain even when these fields are absent.
    note('music-mix-not-translated',{fields:['fades','ducking','padding'],message:'Music timing and scalar volume are retained. Recreate fades, ducking and padding in the editor.'});
  }
  const placements=[];
  if(Array.isArray(audio.narration))for(const [index,item]of audio.narration.entries()){
    if(!item.artifact){note('generated-audio-not-translated',{index});continue;}
    const media=source(item.artifact,true),from=item.in??0,startSeconds=item.start??0,to=item.out??media.metadata.duration;
    if(!Number.isFinite(from)||!Number.isFinite(to)||!Number.isFinite(startSeconds)||from<0||to<=from||startSeconds<0||startSeconds>=elapsed||Number.isFinite(media.metadata.duration)&&to>media.metadata.duration+.05)throw new Error('Use valid added audio ranges and placement times.');
    const start=Math.round(startSeconds*sequenceRate.fps),end=Math.min(totalFrames,Math.round((startSeconds+to-from)*sequenceRate.fps));
    if(end<=start)throw new Error('Added audio is shorter than one exportable frame.');
    placements.push({id:'placement-'+(index+1),media,start,end,inFrame:Math.round(from*sequenceRate.fps),outFrame:Math.round(from*sequenceRate.fps)+end-start,gain:audioGain(item.volume,1)});
    const fields=Object.keys(item).filter(key=>!['artifact','start','in','out','volume'].includes(key));
    if(fields.length)note('audio-placement-mix-not-translated',{index,fields,message:'Added audio timing and scalar volume are retained. Other audio effects require editor work.'});
  }
  const audioExtra=Object.keys(audio).filter(key=>!['music_bed','narration'].includes(key));if(audioExtra.length)note('audio-layers-not-translated',{fields:audioExtra});
  const visualPlacements=[];
  // Sort both media kinds together after preserving their validation and identities.
  for(const [index,item]of (edl.image_overlays||[]).entries()){
    const media=source(item.image_path),startSeconds=item.start??0,finish=item.end??elapsed;
    if(!Number.isFinite(startSeconds)||!Number.isFinite(finish)||startSeconds<0||startSeconds>=elapsed||finish<=startSeconds)throw Error('Use valid image placement times.');
    const start=Math.round(startSeconds*sequenceRate.fps),end=Math.min(totalFrames,Math.round(finish*sequenceRate.fps));
    if(end<=start)throw Error('An image is shorter than one exportable frame.');
    visualPlacements.push({id:'image-placement-'+(index+1),media,start,end,inFrame:0,outFrame:end-start,still:true});
    const fields=Object.keys(item).filter(key=>!['image_path','start','end','layer_order'].includes(key));
    if(fields.length)note('image-placement-transforms-not-translated',{index,fields,message:'Image files and timing are retained. Position, size, opacity and effects require editor work.'});
  }
  for(const [index,item]of (edl.video_overlays||[]).entries()){
    const media=source(item.source_path),from=item.in??0,to=item.out??media.metadata.duration,startSeconds=item.start??0;
    if(!Number.isFinite(from)||!Number.isFinite(to)||!Number.isFinite(startSeconds)||from<0||to<=from||startSeconds<0||startSeconds>=elapsed||Number.isFinite(media.metadata.duration)&&to>media.metadata.duration+.05)throw Error('Use valid added video ranges and placement times.');
    const finish=item.end??startSeconds+to-from;
    if(!Number.isFinite(finish)||finish<=startSeconds||finish>startSeconds+to-from+.05)throw Error('Added video placement exceeds its selected source range.');
    const start=Math.round(startSeconds*sequenceRate.fps),end=Math.min(totalFrames,Math.round(finish*sequenceRate.fps));
    if(end<=start)throw Error('Added video is shorter than one exportable frame.');
    visualPlacements.push({id:'visual-placement-'+(index+1),media,start,end,inFrame:Math.round(from*sequenceRate.fps),outFrame:Math.round(from*sequenceRate.fps)+end-start});
    const fields=Object.keys(item).filter(key=>!['source_path','start','end','in','out','layer_order'].includes(key));
    if(fields.length)note('video-placement-transforms-not-translated',{index,fields,message:'Added video cuts and timing are retained. Position, size, opacity and effects require editor work.'});
  }
  const placementOrder=new Map(visualOverlayOrder(edl).map((row,index)=>[(row.kind==='image'?'image-placement-':'visual-placement-')+(row.index+1),index]));
  visualPlacements.sort((a,b)=>placementOrder.get(a.id)-placementOrder.get(b.id));
  const writtenFiles=new Set();
  const fileXml=media=>{
    if(writtenFiles.has(media.id))return `<file id="${media.id}"/>`;writtenFiles.add(media.id);
    const m=media.metadata,r=media.rate;
    return `<file id="${media.id}"><name>${escape(baseName(media.file))}</name><pathurl>${escape(fileUrl(media.file))}</pathurl>${rateXml(r)}${Number.isFinite(m.duration)?`<duration>${Math.round(m.duration*r.fps)}</duration>`:''}<media>${media.audioOnly?'':`<video><samplecharacteristics>${rateXml(r)}${dimension(m.width)&&dimension(m.height)?`<width>${m.width}</width><height>${m.height}</height>`:''}</samplecharacteristics></video>`}<audio>${Number.isInteger(m.sample_rate)&&m.sample_rate>0?`<samplecharacteristics><samplerate>${m.sample_rate}</samplerate></samplecharacteristics>`:''}</audio></media></file>`;
  };
  let audioIndex=0;
  timeline.forEach((cut,index)=>{cut.videoIndex=index+1;if(cut.media.metadata.has_audio!==false)cut.audioIndex=++audioIndex;});
  const clipXml=(cut,kind)=>`<clipitem id="${kind}-${cut.id}"><name>${escape(baseName(cut.media.file))}</name>${rateXml(sequenceRate)}${cut.still?'<stillframe>TRUE</stillframe>':''}<start>${cut.start}</start><end>${cut.end}</end><in>${cut.inFrame}</in><out>${cut.outFrame}</out>${fileXml(cut.media)}<sourcetrack><mediatype>${kind}</mediatype><trackindex>1</trackindex></sourcetrack>${kind==='audio'&&cut.gain!==undefined?gainXml(cut.gain):''}${cut.audioIndex?['video','audio'].map(type=>`<link><linkclipref>${type}-${cut.id}</linkclipref><mediatype>${type}</mediatype><trackindex>1</trackindex><clipindex>${type==='video'?cut.videoIndex:cut.audioIndex}</clipindex></link>`).join(''):''}</clipitem>`;
  const video=timeline.map(cut=>clipXml(cut,'video')).join('');
  const sourceAudio=timeline.filter(cut=>cut.audioIndex).map(cut=>clipXml(cut,'audio')).join('');
  if(sourceAudio||music||placements.length)note('audio-channel-routing-unverified',{message:'One source audio track is referenced per clip; multichannel routing requires editor verification.'});
  const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE xmeml><xmeml version="5"><sequence id="sequence-1"><name>${escape(title)}</name><duration>${totalFrames}</duration>${rateXml(sequenceRate)}<media><video><format><samplecharacteristics>${rateXml(sequenceRate)}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format><track>${video}</track>${visualPlacements.map(item=>`<track>${clipXml(item,'video')}</track>`).join('')}</video><audio><format><samplecharacteristics><samplerate>48000</samplerate></samplecharacteristics></format><track>${sourceAudio}</track>${music?`<track>${clipXml(music,'audio')}</track>`:''}${placements.map(item=>`<track>${clipXml(item,'audio')}</track>`).join('')}</audio></media></sequence></xmeml>`;
  return {xml,support:{format:'xmeml',version:5,editor_import_verified:false,retained:[...(edl.image_overlays?.length?['image-placements']:[]),...(edl.video_overlays?.length?['video-placements']:[]),'source-cuts','sequence-frame-rate','sequence-dimensions',...(sourceAudio?['source-audio']:[]),...(music?['music-track','music-volume']:[]),...(placements.length?['audio-placements','audio-placement-volume']:[])],limitations,sequence:{width,height,fps:sequenceRate.fps,timebase:sequenceRate.timebase,ntsc:sequenceRate.ntsc,duration_frames:totalFrames},quantization:{timeline:'nearest sequence frame at cumulative cut boundaries',source:'nearest sequence frame (native source rate retained in file metadata)',maximum_error_frames:0.5}}};
}
