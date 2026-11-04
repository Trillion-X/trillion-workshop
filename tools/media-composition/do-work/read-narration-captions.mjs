// Bind a film's subtitle sidecar to the same declared narration as its speech.
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';

const normalize = text => text.normalize('NFKC').replace(/\s+/gu,' ').trim();
// SRT timestamps have millisecond precision. This covers serialization rounding,
// not an allowance for acoustic alignment error or an arbitrary subtitle delay.
const SRT_PRECISION = .001;
const textUnits = text => normalize(text).match(/[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu)??[];
const exceedsPrecision = (difference,a,b) => difference>SRT_PRECISION+4*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));
const seconds = value => {
  const match=/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);
  if(!match)throw new Error('Narration caption timestamp is malformed');
  return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;
};

function captionAlignment(cues,timeline) {
  const scope='declared_word_timestamps_only';
  const unavailable=reason=>({status:'unavailable',scope,reason,acoustic_observation:'unverified'});
  const lineWords=timeline.lines.every(line=>Array.isArray(line.words)&&line.words.length)
    ?timeline.lines.flatMap(line=>line.words):null;
  const flatWords=Array.isArray(timeline.words)&&timeline.words.length?timeline.words:null;
  const raw=lineWords??flatWords;
  if(!raw)return unavailable('No complete declared word-time source');
  const words=raw.map(word=>({text:typeof(word?.text??word?.word)==='string'?normalize(word.text??word.word):'',start:word?.start,end:word?.end}));
  if(words.some((word,i)=>!word.text||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start||word.end>timeline.duration+SRT_PRECISION||(i&&word.start<words[i-1].start-SRT_PRECISION)))return unavailable('Declared word times are incomplete, unordered or outside the duration');
  const units=words.flatMap(word=>textUnits(word.text)),expected=textUnits(timeline.lines.map(line=>line.text).join(' '));
  if(units.length!==expected.length||units.some((unit,i)=>unit!==expected[i]))return unavailable('Declared word-time text differs from the narration');
  if(lineWords&&flatWords){
    const same=flatWords.length===words.length&&flatWords.every((word,i)=>normalize(String(word?.text??word?.word??''))===words[i].text&&Math.abs(word.start-words[i].start)<=SRT_PRECISION&&Math.abs(word.end-words[i].end)<=SRT_PRECISION);
    if(!same)return unavailable('Declared line and flat word clocks disagree');
  }
  // Formatting around punctuation/symbols need not match timestamp tokenization.
  // Keep each original timed span whole; never invent times inside an anchor.
  let position=0;
  const anchors=words.map(word=>{const from=position;position+=textUnits(word.text).length;return {...word,from,to:position};});
  const findings=[];let offset=0,anchorIndex=0;
  for(const [index,cue]of cues.entries()){
    const endOffset=offset+textUnits(cue.text).length;
    while(anchors[anchorIndex].to<=offset)anchorIndex++;
    let lastIndex=anchorIndex;while(anchors[lastIndex].to<endOffset)lastIndex++;
    const assigned=anchors.slice(anchorIndex,lastIndex+1),first=assigned[0];
    const last=assigned.reduce((latest,word)=>word.end>latest.end?word:latest,assigned[0]);
    const previous=words[anchorIndex-1],next=words[lastIndex+1];
    const splitStart=first.from<offset,splitEnd=anchors[lastIndex].to>endOffset;offset=endOffset;
    const late=cue.start-first.start,early=last.end-cue.end;
    if(splitStart)findings.push({cue:index+1,kind:'ambiguous_text_anchor',word:first.text,boundary:'start'});
    if(splitEnd)findings.push({cue:index+1,kind:'ambiguous_text_anchor',word:anchors[lastIndex].text,boundary:'end'});
    if(!splitStart&&exceedsPrecision(late,cue.start,first.start)){
      const ambiguous=previous&&previous.end>first.start+SRT_PRECISION&&cue.start<=previous.end+SRT_PRECISION;
      findings.push({cue:index+1,kind:ambiguous?'ambiguous_word_overlap':'late_start',word:first.text,declared_time:first.start,caption_time:cue.start,seconds:late});
    }
    if(!splitEnd&&exceedsPrecision(early,cue.end,last.end)){
      const ambiguous=next&&next.start<last.end-SRT_PRECISION&&cue.end>=next.start-SRT_PRECISION;
      findings.push({cue:index+1,kind:ambiguous?'ambiguous_word_overlap':'early_end',word:last.text,declared_time:last.end,caption_time:cue.end,seconds:early});
    }
  }
  return {status:findings.some(f=>f.kind==='late_start'||f.kind==='early_end')?'misaligned':findings.length?'ambiguous':'aligned',scope,precision_seconds:SRT_PRECISION,word_count:words.length,findings,acoustic_observation:'unverified'};
}

export function readNarrationCaptions({voiceDir,timeline}) {
  const declared=timeline?.captions?.srt;
  if(typeof declared!=='string'||!declared.endsWith('.srt')||isAbsolute(declared))throw new Error('Narration timeline must declare its relative SRT');
  const root=realpathSync(voiceDir),path=realpathSync(resolve(root,declared));
  const within=relative(root,path);
  if(within==='..'||within.startsWith('../')||isAbsolute(within))throw new Error('Narration captions must remain inside their voice directory');
  if(!Number.isFinite(timeline.duration)||timeline.duration<=0||!Array.isArray(timeline.lines)||!timeline.lines.length||timeline.lines.some(line=>typeof line.text!=='string'||!line.text.trim()))throw new Error('Narration caption binding needs nonempty timed narration');
  const text=readFileSync(path,'utf8').replace(/^\uFEFF/,'');
  const blocks=text.trim().split(/\r?\n\s*\r?\n/u);
  const cues=blocks.map((block,index)=>{
    const rows=block.split(/\r?\n/u);
    if(rows[0]!==String(index+1))throw new Error('Narration caption sequence is malformed');
    const stamp=/^(\S+) --> (\S+)$/.exec(rows[1]??'');
    if(!stamp)throw new Error('Narration caption timing is missing');
    const start=seconds(stamp[1]),end=seconds(stamp[2]),words=normalize(rows.slice(2).join(' '));
    if(!words||end<=start||end>timeline.duration+.05)throw new Error('Narration caption is empty or outside its speech timeline');
    return {start,end,text:words};
  });
  if(cues.some((cue,index)=>index&&cue.start<cues[index-1].start))throw new Error('Narration captions are out of order');
  if(Number.isInteger(timeline.captions.cues)&&timeline.captions.cues!==cues.length)throw new Error('Narration caption count differs from its timeline');
  if(normalize(cues.map(cue=>cue.text).join(' '))!==normalize(timeline.lines.map(line=>line.text).join(' ')))throw new Error('Narration captions differ from the current spoken words');
  const alignment=captionAlignment(cues,timeline);
  if(alignment.status==='misaligned'){
    const error=new Error('Caption timing does not cover its declared word times; check the caption or declared word clock');
    error.code='NARRATION_CAPTION_ALIGNMENT';error.alignment=alignment;throw error;
  }
  return {path,text,cues,alignment};
}
