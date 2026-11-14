// Normalized source-space centers match the media renderer's crop track.
export function cropBounds(width,height,ratio,center={x:.5,y:.5}) {
  const w=Math.min(1,ratio/(width/height)),h=Math.min(1,(width/height)/ratio);
  const x=Math.max(w/2,Math.min(1-w/2,center.x)),y=Math.max(h/2,Math.min(1-h/2,center.y));
  return {x,y,width:w,height:h,left:x-w/2,top:y-h/2};
}

export function mountCropPosition(host,{url,ratio=9/16,center={x:.5,y:.5},start=0,onChange}) {
  const stage=document.createElement('div'),video=document.createElement('video'),mask=document.createElement('div'),note=document.createElement('p');
  stage.className='media-crop-stage';video.src=url;video.muted=true;video.playsInline=true;video.preload='metadata';
  mask.className='media-crop-window';mask.tabIndex=0;mask.setAttribute('role','slider');mask.setAttribute('aria-label','Crop position');mask.setAttribute('aria-valuemin','0');mask.setAttribute('aria-valuemax','100');
  note.textContent='Drag the frame to choose what stays in the video. Arrow keys move it; Shift moves faster.';
  stage.append(video,mask);host.append(stage,note);let current={...center},drag=null;
  const paint=()=>{if(!video.videoWidth)return;const b=cropBounds(video.videoWidth,video.videoHeight,ratio,current);current={x:b.x,y:b.y};stage.style.aspectRatio=String(video.videoWidth/video.videoHeight);Object.assign(mask.style,{left:b.left*100+'%',top:b.top*100+'%',width:b.width*100+'%',height:b.height*100+'%'});mask.setAttribute('aria-valuenow',String(Math.round(current.x*100)));mask.setAttribute('aria-valuetext',`Horizontal ${Math.round(current.x*100)}%, vertical ${Math.round(current.y*100)}%`);};
  video.onloadedmetadata=()=>{video.currentTime=Math.min(start,Math.max(0,video.duration-.05));paint();};
  mask.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();mask.focus();mask.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,center:{...current}};};
  mask.onpointermove=e=>{if(!drag||drag.id!==e.pointerId)return;const r=stage.getBoundingClientRect();current={x:drag.center.x+(e.clientX-drag.x)/r.width,y:drag.center.y+(e.clientY-drag.y)/r.height};paint();onChange?.({...current});};
  mask.onpointerup=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;onChange?.({...current});};
  mask.onpointercancel=()=>{if(drag){current=drag.center;drag=null;paint();}};
  mask.onkeydown=e=>{const delta=e.shiftKey?.05:.01,steps={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]};if(!steps[e.key])return;e.preventDefault();current={x:current.x+steps[e.key][0],y:current.y+steps[e.key][1]};paint();onChange?.({...current});};
  return {seek(time){if(video.readyState&&Math.abs(video.currentTime-time)>.12)video.currentTime=time;},update(next){ratio=next.ratio??ratio;current=next.center??current;paint();},destroy(){video.pause();video.removeAttribute('src');video.load();stage.remove();note.remove();}};
}
