import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {exportXmeml} from '../export-xmeml.mjs';

// Parse XML with a real independent parser, rather than checking serialized
// substrings against the serializer. No editor import is inferred from this.
function parse(xml){return JSON.parse(execFileSync('python3',['-c',`
import json,sys,xml.etree.ElementTree as ET
s=ET.fromstring(sys.stdin.read()).find('sequence')
def cut(c):
 return {'id':c.get('id'),**{k:c.findtext(k) for k in ['start','end','in','out']},'effects':[{'name':e.findtext('name'),'id':e.findtext('effectid'),'kind':e.findtext('mediatype'),'parameter':e.findtext('parameter/parameterid'),'value':e.findtext('parameter/value')} for e in c.findall('filter/effect')],'links':[{'ref':l.findtext('linkclipref'),'kind':l.findtext('mediatype'),'index':l.findtext('clipindex')} for l in c.findall('link')]}
print(json.dumps({'name':s.findtext('name'),'duration':s.findtext('duration'),'rate':s.findtext('rate/timebase'),'ntsc':s.findtext('rate/ntsc'),'width':s.findtext('media/video/format/samplecharacteristics/width'),'height':s.findtext('media/video/format/samplecharacteristics/height'),'video':[[cut(c) for c in t.findall('clipitem')] for t in s.findall('media/video/track')],'audio':[[cut(c) for c in t.findall('clipitem')] for t in s.findall('media/audio/track')],'files':[{'id':f.get('id'),'url':f.findtext('pathurl'),'rate':f.findtext('rate/timebase')} for f in s.findall('.//file') if f.find('pathurl') is not None]}))
`],{input:xml,encoding:'utf8'}));}
const clip=(source,from,to,extra={})=>({kind:'clip',source,in:from,out:to,...extra});
const base=segments=>({spine:{segments},encode:{width:720,height:1280,fps:30}});

test('mixed image and video tracks follow explicit paint order',()=>{
 const edl={...base([clip('/tmp/base.mp4',0,5)]),image_overlays:[{image_path:'/tmp/art.png',start:0,end:2,layer_order:1}],video_overlays:[{source_path:'/tmp/back.mp4',in:0,out:2,start:0,layer_order:0},{source_path:'/tmp/front.mp4',in:0,out:2,start:0,layer_order:2}]};
 const result=exportXmeml({title:'Mixed tracks',edl});
 assert.deepEqual(parse(result.xml).video.slice(1).map(track=>track[0].id),['video-visual-placement-1','video-image-placement-1','video-visual-placement-2']);
 assert.ok(!result.support.limitations.some(row=>row.fields?.includes('layer_order')));
});

test('image handoff retains still files, timing and renderer layer order',()=>{
 const edl={...base([clip('/tmp/base.mp4',0,5)]),image_overlays:[{image_path:'/tmp/art & title.png',start:1,end:3,width:300},{image_path:'/tmp/art & title.png',start:4,end:8}],video_overlays:[{source_path:'/tmp/extra.mp4',in:0,out:1,start:2,end:3}]};
 const result=exportXmeml({title:'Image handoff',edl}),value=parse(result.xml);
 assert.deepEqual(value.video.map(track=>track.map(c=>[c.start,c.end])),[[['0','150']],[['30','90']],[['120','150']],[['60','90']]]);
 assert.equal(value.files.filter(file=>file.url.endsWith('art%20&%20title.png')).length,1);
 const still=execFileSync('python3',['-c',"import sys,xml.etree.ElementTree as E;print(','.join(c.findtext('stillframe','FALSE') for c in E.fromstring(sys.stdin.read()).findall('.//video/track/clipitem')))"],{input:result.xml,encoding:'utf8'}).trim();assert.equal(still,'FALSE,TRUE,TRUE,FALSE');
 assert.ok(result.support.retained.includes('image-placements'));assert.ok(result.support.limitations.some(row=>row.code==='image-placement-transforms-not-translated'));assert.equal(result.support.editor_import_verified,false);
 for(const patch of [{start:-1},{start:5},{end:0},{end:NaN},{image_path:'relative.png'},{end:1.001}])assert.throws(()=>exportXmeml({title:'Invalid',edl:{...edl,image_overlays:[{...edl.image_overlays[0],...patch}]}}));
});

test('added video keeps a separate track with source cuts and honest transform limits',()=>{
 const edl={...base([clip('/tmp/base.mp4',0,5)]),video_overlays:[{source_path:'/tmp/extra.mp4',in:2,out:3,start:1,end:2,width:300,x:'(W-w)*0.5',opacity:.8}]};
 const result=exportXmeml({title:'Layers',edl,sourceMetadata:{'/tmp/base.mp4':{fps:30,duration:5,has_audio:false},'/tmp/extra.mp4':{fps:60,duration:4,has_audio:true}}});
 const value=parse(result.xml);assert.equal(value.video.length,2);assert.deepEqual(value.video[1].map(c=>[c.start,c.end,c.in,c.out]),[['30','60','60','90']]);assert.equal(value.audio[0].length,0);
 assert.ok(result.support.retained.includes('video-placements'));assert.ok(result.support.limitations.some(row=>row.code==='video-placement-transforms-not-translated'));assert.equal(result.support.editor_import_verified,false);
 assert.throws(()=>exportXmeml({title:'Invalid',edl:{...edl,video_overlays:[{...edl.video_overlays[0],end:4}]}}),/exceeds/);
});

test('portrait sequence preserves real source frame rate and cumulative cut timing with linked source audio',()=>{
 const result=exportXmeml({title:'A & B <cut>',edl:base([clip('/tmp/a & b.mp4',1,2.5),clip('/tmp/a & b.mp4',3,4)]),sourceMetadata:{'/tmp/a & b.mp4':{fps:60,duration:10,width:1920,height:1080,has_audio:true,sample_rate:44100}}});
 const value=parse(result.xml);assert.equal(value.name,'A & B <cut>');assert.equal(value.width,'720');assert.equal(value.height,'1280');assert.equal(value.duration,'75');
 assert.deepEqual(value.video[0].map(c=>[c.start,c.end,c.in,c.out]),[['0','45','30','75'],['45','75','90','120']]);
 assert.equal(value.files.length,1);assert.equal(value.files[0].rate,'60');assert.match(value.files[0].url,/a%20&%20b.mp4/);
 assert.deepEqual(value.audio[0].map(c=>[c.start,c.end]),[['0','45'],['45','75']]);assert.equal(value.video[0][1].links.find(l=>l.kind==='audio').index,'2');
 assert.equal(result.support.editor_import_verified,false);
});

test('fractional rate is encoded as nominal NTSC rate without per-cut rounding drift',()=>{
 const edl=base(Array.from({length:10},()=>clip('/tmp/ntsc.mov',0,.15)));edl.encode.fps=30000/1001;
 const result=exportXmeml({title:'NTSC',edl,sourceMetadata:{'/tmp/ntsc.mov':{fps:30000/1001,duration:2,has_audio:false}}});
 const value=parse(result.xml);assert.equal(value.rate,'30');assert.equal(value.ntsc,'TRUE');assert.equal(value.duration,String(Math.round(1.5*30000/1001)));assert.equal(value.audio[0].length,0);
 for(let i=1;i<10;i++)assert.equal(value.video[0][i].start,value.video[0][i-1].end);
});

test('music is a separate trimmed audio track and nonportable render work is explicitly reported',()=>{
 const edl=base([clip('/tmp/video.mp4',0,5,{grade:'eq=contrast=1.1',reframe:{fill_mode:'cover'}})]);
 edl.audio_graph={music_bed:{artifact:'/tmp/music.wav',trim:[2,7],volume:.12,duck:true}};edl.subtitles={ass:'actual subtitles'};
 const result=exportXmeml({title:'Music',edl,sourceMetadata:{'/tmp/video.mp4':{fps:30,duration:5,has_audio:true},'/tmp/music.wav':{fps:30,duration:4,sample_rate:48000}}});
 const value=parse(result.xml);assert.equal(value.audio.length,2);assert.deepEqual(value.audio[1].map(c=>[c.start,c.end,c.in,c.out]),[['0','60','60','120']]);
 assert.ok(result.support.retained.includes('music-track'));assert.ok(result.support.limitations.some(l=>l.code==='clip-transforms-not-translated'&&l.fields.includes('grade')&&l.fields.includes('reframe')));assert.ok(result.support.limitations.some(l=>l.code==='captions-not-translated'));assert.ok(result.support.limitations.some(l=>l.code==='music-mix-not-translated'));
});

test('audio link indexes remain correct when a silent source precedes a source with sound',()=>{
 const result=exportXmeml({title:'Silent then sound',edl:base([clip('/tmp/silent.mp4',0,1),clip('/tmp/sound.mp4',0,1)]),sourceMetadata:{'/tmp/silent.mp4':{fps:30,has_audio:false},'/tmp/sound.mp4':{fps:30,has_audio:true}}});
 const value=parse(result.xml);assert.equal(value.audio[0].length,1);assert.equal(value.video[0][1].links.find(l=>l.kind==='audio').index,'1');assert.equal(value.audio[0][0].links.find(l=>l.kind==='video').index,'2');
});

test('added audio preserves independent source ranges and placement times on editable tracks',()=>{
 const edl=base([clip('/tmp/video.mp4',0,5)]);edl.audio_graph={narration:[{artifact:'/tmp/sound.wav',start:1,in:2,out:3,volume:.5},{artifact:'/tmp/sound.wav',start:4,in:0,out:2,volume:.25}]};
 const result=exportXmeml({title:'Audio placements',edl,sourceMetadata:{'/tmp/video.mp4':{fps:30,duration:5,has_audio:false},'/tmp/sound.wav':{duration:6,sample_rate:48000}}});
 const value=parse(result.xml);assert.equal(value.audio.length,3);assert.deepEqual(value.audio[1].map(c=>[c.start,c.end,c.in,c.out]),[['30','60','60','90']]);assert.deepEqual(value.audio[2].map(c=>[c.start,c.end,c.in,c.out]),[['120','150','0','30']]);
 assert.ok(result.support.retained.includes('audio-placements'));assert.ok(result.support.retained.includes('audio-placement-volume'));assert.equal(result.support.limitations.some(l=>l.code==='audio-placement-mix-not-translated'),false);assert.equal(result.support.editor_import_verified,false);
 edl.audio_graph.narration[0].start=8;assert.throws(()=>exportXmeml({title:'Invalid',edl,sourceMetadata:{'/tmp/sound.wav':{duration:6}}}),/valid added audio/);
});

test('Audio Levels retains linear music and placement volume including exact mute and defaults',()=>{
 const edl=base([clip('/tmp/video.mp4',0,5)]);edl.audio_graph={music_bed:{artifact:'/tmp/music.wav',trim:[0,5],volume:0},narration:[{artifact:'/tmp/voice.wav',start:0,in:0,out:1,volume:0},{artifact:'/tmp/voice.wav',start:1,in:0,out:1,volume:.25},{artifact:'/tmp/voice.wav',start:2,in:0,out:1,volume:1},{artifact:'/tmp/voice.wav',start:3,in:0,out:1}]};
 const result=exportXmeml({title:'Gain',edl}),value=parse(result.xml);
 assert.deepEqual(value.audio.slice(1).map(track=>track[0].effects),[0,0,.25,1,1].map(gain=>[{name:'Audio Levels',id:'audiolevels',kind:'audio',parameter:'level',value:String(gain)}]));
 assert.deepEqual(value.video[0][0].effects,[]);assert.deepEqual(value.audio[0][0].effects,[],'source sound does not acquire the added layer gain');
 assert.ok(result.support.retained.includes('music-volume'));assert.equal(result.support.limitations.find(l=>l.code==='music-mix-not-translated').fields.includes('gain'),false);
 delete edl.audio_graph.music_bed.volume;assert.equal(parse(exportXmeml({title:'Defaults',edl}).xml).audio[1][0].effects[0].value,'0.9');
 assert.equal(result.support.editor_import_verified,false);
});

test('invalid scalar gain is rejected and additional placement effects remain explicit',()=>{
 for(const volume of [-1,NaN,Infinity,'0.5'])for(const kind of ['music_bed','narration']){
  const edl=base([clip('/tmp/video.mp4',0,5)]),item={artifact:'/tmp/audio.wav',in:0,out:1,trim:[0,1],volume};edl.audio_graph={[kind]:kind==='narration'?[item]:item};
  assert.throws(()=>exportXmeml({title:'Invalid gain',edl}),/finite nonnegative audio volume/);
 }
 const edl=base([clip('/tmp/video.mp4',0,5)]);edl.audio_graph={narration:[{artifact:'/tmp/audio.wav',in:0,out:1,volume:.5,fade_out:{d:1}}]};
 assert.deepEqual(exportXmeml({title:'Unsupported effect',edl}).support.limitations.find(l=>l.code==='audio-placement-mix-not-translated').fields,['fade_out']);
});

test('invalid ranges and unsupported sequence rates fail instead of inventing an export',()=>{
 for(const segment of [clip('/tmp/a.mp4',2,1),clip('/tmp/a.mp4',0,.001),clip('relative.mp4',0,1),clip('/tmp/a.mp4',0,1,{speed:2}),{kind:'base_span',source:'/tmp/a.mp4',in:0,out:1}])assert.throws(()=>exportXmeml({title:'Invalid',edl:base([segment])}));
 const edl=base([clip('/tmp/a.mp4',0,1)]);edl.encode.fps=27.5;assert.throws(()=>exportXmeml({title:'Invalid',edl}),/fractional/);
 assert.throws(()=>exportXmeml({title:'Invalid',edl:base([clip('/tmp/a.mp4',0,2)]),sourceMetadata:{'/tmp/a.mp4':{fps:30,duration:1}}}),/source duration/);
});
