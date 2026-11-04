const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
export function objectMaskGeometry({plan,aspect,framing_mode,visual_layers}){
 const segments=plan.segments.map(({id,start,end,frame})=>({id,start,end,...(frame?{frame}:{})}));
 const visuals=(visual_layers||[]).map(row=>Object.fromEntries(['id','start','in','out','x','y','scale','opacity'].map(k=>[k,row[k]])));
 return JSON.stringify(stable({segments,aspect,framing_mode,visual_layers:visuals}));
}
