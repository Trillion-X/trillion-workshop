// Points use source seconds, so trimming and splitting preserve their meaning.
export function positionAt(frame, time) {
  const points=frame?.track;
  if(!points?.length)return {x:frame?.x??.5,y:frame?.y??.5};
  if(time<=points[0].t)return {x:points[0].x,y:points[0].y};
  for(let i=1;i<points.length;i++)if(time<=points[i].t){const a=points[i-1],b=points[i],p=(time-a.t)/(b.t-a.t);return {x:a.x+(b.x-a.x)*p,y:a.y+(b.y-a.y)*p};}
  return {x:points.at(-1).x,y:points.at(-1).y};
}
export function validatePositionTrack(frame) {
  if(frame==null)return;
  if(typeof frame!=='object'||Array.isArray(frame)||Object.keys(frame).some(k=>!['x','y','track'].includes(k))||['x','y'].some(k=>!Number.isFinite(frame[k])||frame[k]<0||frame[k]>1))throw Error('Choose a frame center within the recording.');
  if(frame.track!==undefined){let last=-1;if(!Array.isArray(frame.track)||frame.track.length>500)throw Error('Choose a valid crop animation.');for(const point of frame.track){if(!point||Object.keys(point).some(k=>!['t','x','y'].includes(k))||![point.t,point.x,point.y].every(Number.isFinite)||point.t<0||point.t<=last||point.x<0||point.x>1||point.y<0||point.y>1)throw Error('Choose ordered crop positions inside the recording.');last=point.t;}}
}
export function renderPositionTrack(frame,start,end){
  return [{t:0,...positionAt(frame,start)},...(frame.track||[]).filter(p=>p.t>start&&p.t<end).map(p=>({...p,t:p.t-start})),{t:end-start,...positionAt(frame,end)}].map(p=>({t:p.t,cx:p.x,cy:p.y}));
}
