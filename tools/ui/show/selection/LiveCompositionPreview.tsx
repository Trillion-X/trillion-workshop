import React from 'react';
import {PlaybackControls} from '../../../media-playback/show/PlaybackControls';
import {cropBounds} from './crop-position.mjs';
import {LutVideo} from './LutVideo';
import {positionAt} from '../../../media-composition/read-data/position-track.mjs';
import {adjustmentCss} from '../../../media-composition/read-data/adjustment-layers.mjs';
import {SpatialLayer} from './SpatialLayer';
import {StyledCaption} from '../caption-overlay/StyledCaption';

// A draft is played from its original media. Editing geometry, captions and
// layer timing changes this composition, never requires encoding another video.
// Captions (`captions`: a caption style row as `look`, cut-time lines with their
// words, `measuredAt`) are drawn in their style by the shared StyledCaption, the
// same style row the burned-in subtitle is built from.
export function LiveCompositionPreview({composition:c,onTimeChange,seekRequest,dragPlacement,canvasDropHandlers}:any){
 const video=React.useRef<HTMLVideoElement>(null),shell=React.useRef<HTMLDivElement>(null),clock=React.useRef(0);
 const [fullscreen,setFullscreen]=React.useState(false);
 React.useEffect(()=>{const changed=()=>setFullscreen(document.fullscreenElement===shell.current);document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);},[]);
 const [time,setTime]=React.useState(0),[playing,setPlaying]=React.useState(false),[muted,setMuted]=React.useState(false),[volume,setVolume]=React.useState(1),[speed,setSpeed]=React.useState(1),[dimensions,setDimensions]=React.useState({width:1920,height:1080}),[error,setError]=React.useState(''),[frameReady,setFrameReady]=React.useState(false),[frameContent,setFrameContent]=React.useState<'pending'|'visible'|'black'|'unreadable'>('pending');
 React.useEffect(()=>{if(c.selectObject)setPlaying(false);},[c.selectObject]);
 React.useEffect(()=>{if(dragPlacement)setPlaying(false);},[!!dragPlacement]);
 let offset=0;const cuts=c.segments.map((cut:any)=>{const value={...cut,offset};offset+=cut.end-cut.start;return value;}),duration=offset;
 const cut=cuts.find((cut:any)=>time>=cut.offset&&time<cut.offset+cut.end-cut.start)||cuts.at(-1),source=c.sources[cut?.id],ratio=c.width/c.height;
 React.useEffect(()=>{if(source?.preview_url)setError('');},[source?.preview_url]);
 React.useEffect(()=>{setFrameReady(false);setFrameContent('pending');},[source?.preview_url,cut?.id,cut?.start]);
 const inspectFrame=(v:HTMLVideoElement)=>{
  if(video.current!==v||v.readyState<2||!v.videoWidth||!v.videoHeight)return;
  setFrameReady(true);
  try{setFrameContent(hasNonBlackDecodedPixels(v)?'visible':'black');}catch{setFrameContent('unreadable');}
 };
 const report=(value:number)=>{clock.current=value;setTime(value);onTimeChange?.(value,duration);};
 const seek=(value:number)=>{const next=Math.max(0,Math.min(duration-.001,value));report(next);const target=cuts.find((row:any)=>next>=row.offset&&next<row.offset+row.end-row.start);if(target===cut&&video.current)video.current.currentTime=target.start+next-target.offset;};
 React.useEffect(()=>{if(seekRequest)seek(seekRequest.seconds);},[seekRequest?.requestId]);
 React.useEffect(()=>{if(clock.current>=duration)seek(0);},[duration]);
 React.useEffect(()=>{const v=video.current;if(v&&v.readyState){v.currentTime=cut.start+Math.max(0,clock.current-cut.offset);if(playing)void v.play().catch(()=>{});}},[source?.preview_url,cut?.offset,cut?.start]);
 React.useEffect(()=>{const v=video.current;if(!v)return;v.volume=volume;v.muted=muted;v.playbackRate=speed;if(playing)void v.play().catch(()=>setPlaying(false));else v.pause();},[playing,muted,volume,speed,source?.preview_url]);
 React.useEffect(()=>{if(!playing)return;let raf:number;const tick=()=>{const v=video.current;if(v&&v.readyState>=2){const next=cut.offset+v.currentTime-cut.start;if(v.currentTime>=cut.end-.025){if(cut===cuts.at(-1)){setPlaying(false);report(duration);}else{report(cut.offset+cut.end-cut.start+.001);}}else report(Math.max(cut.offset,next));}raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,cut?.id,cut?.offset,cut?.start,cut?.end,duration]);
 const bounds=cropBounds(dimensions.width,dimensions.height,ratio,positionAt(cut?.frame,time-cut.offset+cut.start));
 const fill=cut?.frame||c.framing==='crop'||c.framing==='face';
 const position=`${bounds.width<1?bounds.left/(1-bounds.width)*100:50}% ${bounds.height<1?bounds.top/(1-bounds.height)*100:50}%`;
 const currentSourceTime=time-cut.offset+cut.start;
 const activeTimedLooks=(c.lookLayers||[]).filter((row:any)=>time>=row.start&&time<row.end).map((row:any)=>row.live_preview).filter(Boolean);
 const timedLook={
  luts:activeTimedLooks.flatMap((preview:any)=>preview.luts||(preview.lut?[preview.lut]:[])),
  filter:activeTimedLooks.map((preview:any)=>preview.filter||'').filter(Boolean).join(' '),
  vignette:activeTimedLooks.some((preview:any)=>preview.vignette),
 };
 const look=dragPlacement?.lookPreview||{
  luts:[...(c.luts||[]),...timedLook.luts],
  filter:[c.filter,timedLook.filter].filter(Boolean).join(' '),
  vignette:Boolean(c.vignette||timedLook.vignette),
 };
 return <div className="live-composition" data-live-composition="" ref={shell}>
  <div className="live-composition-frame" data-canvas-drop-target="" {...canvasDropHandlers} style={{aspectRatio:ratio,width:`min(100%, calc(var(--live-preview-height, 52vh) * ${ratio}))`}}>
   {c.framing==='blur'&&!cut?.frame&&<SyncedMedia url={source?.preview_url} time={currentSourceTime} playing={playing} speed={speed} muted volume={0} className="live-composition-blur"/>}
   <video key={source?.preview_url} ref={video} src={source?.preview_url} poster={source?.poster_url} playsInline preload="auto" className="live-composition-source" data-frame-ready={frameReady?'true':'false'} data-frame-content={frameContent} style={{objectFit:fill?'cover':'contain',objectPosition:position,filter:look.filter||undefined}} onSeeked={()=>{const v=video.current;if(v){report(Math.max(cut.offset,Math.min(duration,cut.offset+v.currentTime-cut.start)));inspectFrame(v);}}} onTimeUpdate={()=>{const v=video.current;if(v)inspectFrame(v);}} onError={()=>setError('The original recording could not play.')} onLoadedMetadata={()=>{const v=video.current!;setError('');setDimensions({width:v.videoWidth,height:v.videoHeight});v.currentTime=cut.start+Math.max(0,clock.current-cut.offset);if(playing)void v.play().catch(()=>{});}} onLoadedData={()=>{const v=video.current;if(!v||v.readyState<2||!v.videoWidth||!v.videoHeight)return;const markReady=()=>inspectFrame(v);if(typeof v.requestVideoFrameCallback==='function')v.requestVideoFrameCallback(()=>markReady());else markReady();}}/>
   {source?.poster_url&&frameContent!=='visible'&&<img className="live-composition-poster-fallback" src={source.poster_url} alt="" aria-hidden="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:fill?'cover':'contain',objectPosition:position,pointerEvents:'none'}}/>}
   {look.luts?.length>0&&<LutVideo video={video} luts={look.luts} style={{objectFit:fill?'cover':'contain',objectPosition:position,filter:look.filter||undefined}} onError={()=>setError('This color preview needs graphics support. Use Preview all changes to check it.')}/>}
   {look.vignette&&<div className="live-composition-vignette"/>}
   {(c.visuals||[]).map((layer:any,index:number)=>{const active=time>=layer.start&&time<layer.start+layer.out-layer.in,asset=c.sources[layer.id];if(!active||!asset)return null;return <SpatialLayer key={index+':'+layer.id} value={layer} label={'Move media '+(index+1)} selected={c.selectedVisual===index} onSelect={()=>c.onVisualSelect?.(index)} onChange={c.onVisualMove?(value:any)=>c.onVisualMove(index,value):undefined}>{asset.media_kind==='image'?<img src={asset.preview_url} alt="" draggable={false}/>:<SyncedMedia url={asset.preview_url} time={layer.in+time-layer.start} playing={playing} speed={speed} muted volume={0}/>}</SpatialLayer>;})}
   {c.captions&&c.captions.lines.filter((row:any)=>time>=row.start&&time<row.end).map((row:any)=><StyledCaption key={row.id??row.start} look={c.captions.look} line={row} time={time} frame={{width:c.width,height:c.height}} measuredAt={c.captions.measuredAt}/>)}
   {(c.adjustments||[]).filter((row:any)=>time>=row.start&&time<row.end&&(!row.mask_id||row.mask&&time>=row.mask.start&&time<row.mask.end)).map((row:any)=>{const mask=row.mask?`url("${row.mask.url}&frame=${Math.min(row.mask.frames-1,Math.max(0,Math.floor((time-row.mask.start)*row.mask.fps)))}")`:undefined;return <div key={row.id} className="live-adjustment-layer" data-adjustment-preview={row.id} style={{left:(mask?0:row.x)*100+'%',top:(mask?0:row.y)*100+'%',width:(mask?1:row.width)*100+'%',height:(mask?1:row.height)*100+'%',background:mask&&c.showMask===row.mask_id?'rgba(0,190,255,.35)':undefined,maskImage:mask,WebkitMaskImage:mask,maskSize:'100% 100%',WebkitMaskSize:'100% 100%',backdropFilter:adjustmentCss(row),WebkitBackdropFilter:adjustmentCss(row)}}/>;})}
   {c.selectObject&&<button type="button" className="live-object-picker" aria-label="Select object in video" onPointerDown={e=>{e.preventDefault();const rect=e.currentTarget.getBoundingClientRect();c.onObjectPoint?.({x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height,include:!e.altKey,time});}}>{(c.objectPoints||[]).map((point:any,index:number)=><span key={index} className={point.include?'included':'excluded'} style={{left:point.x*100+'%',top:point.y*100+'%'}}>{point.include?'+':'−'}</span>)}</button>}
   {dragPlacement&&(dragPlacement.assets||[]).filter((asset:any)=>asset.media_kind!=='audio').map((asset:any,index:number)=><div key={asset.id} className="canvas-placement-preview" data-canvas-placement="" style={{left:(dragPlacement.position?.x??.5)*100+'%',top:(dragPlacement.position?.y??.5)*100+'%',width:'40%',zIndex:30+index}}>{asset.media_kind==='image'?<img src={asset.preview_url} alt=""/>:<video src={asset.preview_url} poster={asset.poster_url} muted playsInline preload="auto"/>}</div>)}
   {dragPlacement?.assets?.some((asset:any)=>asset.media_kind==='audio')&&<div className="canvas-audio-placement" role="status">Audio · {dragPlacement.start.toFixed(2)}s</div>}
   {error&&<p role="alert">{error}</p>}
  </div>
  {(c.audio||[]).map((layer:any,index:number)=>{const active=time>=layer.start&&time<layer.start+(layer.out??duration)-layer.in;return <SyncedMedia key={index+':'+layer.id} audio url={c.sources[layer.id]?.preview_url} time={layer.in+Math.max(0,time-layer.start)} playing={playing&&active} speed={speed} muted={muted||!active} volume={layer.volume*volume}/>;})}
  <div className="live-composition-controls"><PlaybackControls currentTime={time} duration={duration} isFullscreen={fullscreen} isMuted={muted} isPlaying={playing} onSeek={(pct:number)=>seek(duration*pct/100)} onSpeedChange={setSpeed} onToggleFullscreen={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void shell.current?.requestFullscreen();}} onToggleMute={()=>setMuted(!muted)} onTogglePlay={()=>{if(time>=duration)seek(0);setPlaying(!playing);}} onVolumeChange={(percent:number)=>setVolume(percent/100)} playbackSpeed={speed} volume={volume*100} progress={duration?time/duration*100:0} showControls={true}/></div>
 </div>;
}
function hasNonBlackDecodedPixels(video:HTMLVideoElement){
 const canvas=document.createElement('canvas');canvas.width=32;canvas.height=18;
 const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('Canvas pixel sampling is unavailable.');
 context.drawImage(video,0,0,canvas.width,canvas.height);
 const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
 let lit=0;
 for(let i=0;i<pixels.length;i+=4)if(.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2]>12&&pixels[i+3]>0)lit++;
 return lit>=3;
}
function SyncedMedia({url,time,playing,speed,muted,volume,audio,className}:any){
 const ref=React.useRef<any>(null);
 React.useEffect(()=>{const v=ref.current;if(!v||!url)return;v.muted=muted;v.volume=Math.max(0,Math.min(1,volume));v.playbackRate=speed;if(v.readyState&&Math.abs(v.currentTime-time)>.12)v.currentTime=time;if(playing){if(v.paused)void v.play().catch(()=>{});}else v.pause();},[url,time,playing,speed,muted,volume]);
 const props={ref,src:url,preload:'auto',playsInline:true,className,onLoadedMetadata:()=>{if(ref.current)ref.current.currentTime=time;}};
 return audio?<audio {...props}/>:<video {...props}/>;
}
