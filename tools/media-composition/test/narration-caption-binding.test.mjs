import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readNarrationCaptions} from '../do-work/read-narration-captions.mjs';

test('caption binding uses the declared sidecar and refuses stale words, bad time, missing source and mismatched count',()=>{
  const voiceDir=mkdtempSync(join(tmpdir(),'narration-captions-'));
  const timeline={duration:4,captions:{srt:'vo.srt',cues:2},lines:[{text:'The ball reaches the racket.'},{text:'The next ball passes it.'}]};
  const current='1\n00:00:00,100 --> 00:00:01,900\nThe ball reaches\nthe racket.\n\n2\n00:00:02,000 --> 00:00:03,800\nThe next ball passes it.\n';
  try {
    writeFileSync(join(voiceDir,'vo.srt'),current);
    writeFileSync(join(voiceDir,'captions.srt'),'1\n00:00:00,100 --> 00:00:01,900\nWatch the feed change.\n');
    const read=readNarrationCaptions({voiceDir,timeline});
    assert.equal(read.path,realpathSync(join(voiceDir,'vo.srt')));
    assert.equal(read.cues.length,2);
    assert.equal(read.alignment.status,'unavailable');
    writeFileSync(join(voiceDir,'vo.srt'),current.replace('The next ball passes it.','Send the next ball wide.'));
    assert.throws(()=>readNarrationCaptions({voiceDir,timeline}),/differ from the current spoken words/);
    writeFileSync(join(voiceDir,'vo.srt'),current.replace('00:00:03,800','00:00:05,800'));
    assert.throws(()=>readNarrationCaptions({voiceDir,timeline}),/outside its speech timeline/);
    writeFileSync(join(voiceDir,'vo.srt'),current);
    assert.throws(()=>readNarrationCaptions({voiceDir,timeline:{...timeline,captions:{srt:'missing.srt'}}}),/ENOENT/);
    assert.throws(()=>readNarrationCaptions({voiceDir,timeline:{...timeline,captions:{srt:'vo.srt',cues:3}}}),/count differs/);
    assert.throws(()=>readNarrationCaptions({voiceDir,timeline:{...timeline,captions:{}}}),/must declare/);
  }finally{rmSync(voiceDir,{recursive:true,force:true});}
});

const declaredLines=()=>[
  {text:'One part changes another.',words:[{text:'One',start:.35,end:.55},{text:'part',start:.6,end:.8},{text:'changes',start:.9,end:1.6},{text:'another.',start:1.7,end:2.8}]},
  {text:'The result still needs checking.',words:[{text:'The',start:3.2,end:3.4},{text:'result',start:3.5,end:3.8},{text:'still',start:3.9,end:4},{text:'needs',start:4.1,end:4.3},{text:'checking.',start:4.5,end:5.5}]},
];
const spanSrt=(firstEnd='03,000',secondStart='03,000',secondEnd='05,800')=>`1\n00:00:00,000 --> 00:00:${firstEnd}\nOne part changes another.\n\n2\n00:00:${secondStart} --> 00:00:${secondEnd}\nThe result still needs checking.\n`;
function spanFixture(run){
  const voiceDir=mkdtempSync(join(tmpdir(),'narration-caption-spans-'));
  const timeline={duration:6,captions:{srt:'captions.srt',cues:2},lines:declaredLines()};
  const read=(text=spanSrt(),value=timeline)=>{writeFileSync(join(voiceDir,'captions.srt'),text);return readNarrationCaptions({voiceDir,timeline:value});};
  try{run({read,timeline});}finally{rmSync(voiceDir,{recursive:true,force:true});}
}

test('declared-word spans distinguish readable text from a late start or early exit, while preserving useful lead and tail',()=>spanFixture(({read})=>{
  const good=read();
  assert.equal(good.alignment.status,'aligned');
  assert.equal(good.alignment.scope,'declared_word_timestamps_only');
  assert.equal(good.alignment.acoustic_observation,'unverified');
  // Both bad cues still have the same words and need less than 20 characters/s.
  assert.ok('One part changes another.'.length/2.3<20);
  assert.ok('The result still needs checking.'.length/2.2<20);
  assert.throws(()=>read(spanSrt('02,300')),error=>error.code==='NARRATION_CAPTION_ALIGNMENT'&&error.alignment.findings.some(f=>f.kind==='early_end'));
  assert.throws(()=>read(spanSrt('03,000','03,600')),error=>error.code==='NARRATION_CAPTION_ALIGNMENT'&&error.alignment.findings.some(f=>f.kind==='late_start'));
}));

test('alignment permits SRT millisecond rounding but not a wider unrequested timing allowance',()=>spanFixture(({read,timeline})=>{
  timeline.lines[0].words.at(-1).end=2.8004;
  timeline.lines[1].words[0].start=3.0006;
  timeline.lines[1].words.at(-1).end=5.5004;
  assert.equal(read(spanSrt('02,800','03,001','05,500')).alignment.status,'aligned');
  assert.throws(()=>read(spanSrt('02,798','03,001','05,500')),error=>error.alignment.findings.some(f=>f.kind==='early_end'));
}));

test('overlapping declared word boundaries remain ambiguous rather than certified or rejected as acoustic error',()=>spanFixture(({read,timeline})=>{
  timeline.lines[1].words[0].start=2.75;
  const result=read(spanSrt('02,800','02,800'));
  assert.equal(result.alignment.status,'ambiguous');
  assert.ok(result.alignment.findings.every(f=>f.kind==='ambiguous_word_overlap'));
}));

test('partial, nonmatching and competing declared word clocks remain unavailable',()=>spanFixture(({read,timeline})=>{
  const partial=structuredClone(timeline);delete partial.lines[1].words;
  assert.equal(read(spanSrt(),partial).alignment.status,'unavailable');
  const different=structuredClone(timeline);different.lines[0].words[0].text='Different';
  assert.equal(read(spanSrt(),different).alignment.status,'unavailable');
  const competing={...timeline,words:timeline.lines.flatMap(line=>line.words).map(word=>({...word,start:word.start+.2,end:word.end+.2}))};
  assert.equal(read(spanSrt(),competing).alignment.status,'unavailable');
}));

test('a retimed sidecar needs the same declared word clock; correcting the input view preserves the useful artifact',()=>spanFixture(({read,timeline})=>{
  const retimed='1\n00:00:00,000 --> 00:00:04,286\nOne part changes another.\n\n2\n00:00:04,286 --> 00:00:08,286\nThe result still needs checking.\n';
  const wrong={...timeline,duration:8.6};
  assert.throws(()=>read(retimed,wrong),error=>error.code==='NARRATION_CAPTION_ALIGNMENT');
  const correct={...wrong,lines:timeline.lines.map(line=>({...line,words:line.words.map(word=>({...word,start:word.start/.7,end:word.end/.7}))}))};
  assert.equal(read(retimed,correct).alignment.status,'aligned');
}));

test('symbol spacing can share a whole timed anchor without inventing times inside it or merging different words',()=>spanFixture(({read,timeline})=>{
  const value={...timeline,captions:{srt:'captions.srt',cues:1},lines:[{text:'A + B interact.',words:[{text:'A+',start:.2,end:1},{text:'B',start:1.1,end:1.3},{text:'interact.',start:1.4,end:2}]}]};
  assert.equal(read('1\n00:00:00,000 --> 00:00:02,300\nA + B interact.\n',value).alignment.status,'aligned');
  const split={...value,captions:{...value.captions,cues:2}};
  const result=read('1\n00:00:00,000 --> 00:00:00,600\nA\n\n2\n00:00:00,600 --> 00:00:02,300\n+ B interact.\n',split);
  assert.equal(result.alignment.status,'ambiguous');
  assert.ok(result.alignment.findings.some(f=>f.kind==='ambiguous_text_anchor'));
  const different={...value,lines:[{text:'The rapist.',words:[{text:'Therapist.',start:.2,end:2}]}]};
  assert.equal(read('1\n00:00:00,000 --> 00:00:02,300\nThe rapist.\n',different).alignment.status,'unavailable');
}));
