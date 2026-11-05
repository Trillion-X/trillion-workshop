// Synthetic only. The source reports dimensions, never private transcript content.
export const OBSERVED_RESULT_BYTES=2_797_536;
export const OBSERVED_TEXT_BYTES=246_542;
export const OBSERVED_SEGMENTS_BYTES=2_550_883;
export const METADATA_BYTES=111;
export const SEGMENT_COUNT=3325;
export const WORD_COUNT=45094;
export const OBSERVED_WORD_ARRAY_BYTES=2137127;
export function segmentedTranscript(totalBytes){
  // text_bytes is JSON encoding of the string, including its two quotes, as the retained shape was measured.
  let wordAt=0;const rest=WORD_COUNT-30,perRest=Math.floor(rest/(SEGMENT_COUNT-1)),restRemainder=rest%(SEGMENT_COUNT-1);
  const result={text:'t'.repeat(OBSERVED_TEXT_BYTES-2),segments:Array.from({length:SEGMENT_COUNT},(_,i)=>({start:i,end:i+1,text:`segment ${i}:`,words:Array.from({length:i===0?30:perRest+(i-1<restRemainder?1:0)},()=>{const at=wordAt++;return{word:`w${at}`,start:at,end:at+1};})})),language:'en',heard_whole:true,produced_by:'fixture'.padEnd(38,'_')};
  const size=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const initialWords=result.segments.reduce((n,s)=>n+size(s.words),0),wordExtra=OBSERVED_WORD_ARRAY_BYTES-initialWords;
  if(wordExtra<0)throw Error('fixture minimum word JSON exceeds measured native dimensions');
  const perWord=Math.floor(wordExtra/WORD_COUNT),wordRemainder=wordExtra%WORD_COUNT;let n=0;
  for(const segment of result.segments)for(const word of segment.words){word.word+=String.fromCharCode(97+n%26).repeat(perWord+(n<wordRemainder?1:0));n++;}
  const segmentsBytes=totalBytes-OBSERVED_TEXT_BYTES-METADATA_BYTES;
  const extra=segmentsBytes-size(result.segments);
  if(!Number.isSafeInteger(extra)||extra<0)throw Error('fixture size cannot represent segmented shape');
  const per=Math.floor(extra/SEGMENT_COUNT),remainder=extra%SEGMENT_COUNT;
  for(let i=0;i<SEGMENT_COUNT;i++)result.segments[i].text+=String.fromCharCode(97+i%26).repeat(per+(i<remainder?1:0));
  const json=JSON.stringify(result),bytes=new TextEncoder().encode(json);
  const dimensions={text_bytes:size(result.text),text_characters:result.text.length,segments_bytes:size(result.segments),metadata_bytes:bytes.byteLength-size(result.text)-size(result.segments),result_bytes:bytes.byteLength,segments:result.segments.length,words:wordAt,word_array_bytes:result.segments.reduce((n,s)=>n+size(s.words),0),max_words_per_segment:Math.max(...result.segments.map(s=>s.words.length))};
  if(bytes.byteLength!==totalBytes||dimensions.segments_bytes!==segmentsBytes)throw Error('synthetic result dimensions drifted');
  if(dimensions.metadata_bytes!==METADATA_BYTES||dimensions.word_array_bytes!==OBSERVED_WORD_ARRAY_BYTES||dimensions.max_words_per_segment!==30||wordAt!==WORD_COUNT)throw Error('synthetic nested word dimensions drifted');
  if(totalBytes===OBSERVED_RESULT_BYTES&&dimensions.segments_bytes!==OBSERVED_SEGMENTS_BYTES)throw Error('observed segmented size drifted');
  return{result,json,bytes,dimensions};
}
