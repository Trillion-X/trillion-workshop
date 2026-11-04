/** Uncovered half-open ranges inside a measured duration. Never mutates input. */
export function rangeComplement(ranges, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(ranges)) throw new Error('Valid ranges and duration are required.');
  const sorted=ranges.map(range=>{
    if(!range||!Number.isFinite(range.start)||!Number.isFinite(range.end)||range.start<0||range.end<=range.start||range.end>duration)throw new Error('Range is outside its duration.');
    return {start:range.start,end:range.end};
  }).sort((a,b)=>a.start-b.start);
  const gaps=[];let cursor=0;
  for(const range of sorted){if(range.start>cursor)gaps.push({start:cursor,end:range.start});cursor=Math.max(cursor,range.end);}
  if(cursor<duration)gaps.push({start:cursor,end:duration});
  return gaps;
}

/** Insert source material at an explicit sequence boundary; keep existing order and metadata. */
export function insertSourceRange(segments, sourceId, range, at) {
  if(!Array.isArray(segments)||!Number.isInteger(at)||at<0||at>segments.length||typeof sourceId!=='string'||!sourceId||!Number.isFinite(range?.start)||!Number.isFinite(range?.end)||range.start<0||range.end<=range.start)throw new Error('Choose a valid range and insertion position.');
  if(segments.some(cut=>cut.id===sourceId&&cut.start<range.end&&cut.end>range.start))throw new Error('This range is already used in the edit.');
  return [...segments.slice(0,at).map(cut=>({...cut})),{id:sourceId,start:range.start,end:range.end},...segments.slice(at).map(cut=>({...cut}))];
}

/** Move one contiguous-sequence item to the nearest insertion boundary. */
export function moveSequenceItem(segments,index,seconds){
  if(!Array.isArray(segments)||!Number.isInteger(index)||index<0||index>=segments.length||!Number.isFinite(seconds)||seconds<0)throw Error('Choose a valid clip and position.');
  for(const cut of segments)if(!Number.isFinite(cut.start)||!Number.isFinite(cut.end)||cut.start<0||cut.end<=cut.start)throw Error('Choose valid clip boundaries.');
  const moved=segments[index],remaining=segments.filter((_,i)=>i!==index);let cursor=0,at=remaining.length;
  for(let i=0;i<remaining.length;i++){const duration=remaining[i].end-remaining[i].start;if(seconds<cursor+duration/2){at=i;break;}cursor+=duration;}
  return [...remaining.slice(0,at),moved,...remaining.slice(at)].map(cut=>({...cut}));
}
