import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'fflate';
import {keepContentJson,readContentJson,CONTENT_JSON_MAX_BYTES} from '../do-work/content-json.mjs';
import {segmentedTranscript} from './segmented-transcript-fixture.mjs';
const json=JSON.stringify({text:'Complete original 😎'.repeat(20000),segments:Array.from({length:1000},(_,n)=>({start:n,text:'Whole words '.repeat(15)})),heard_whole:true});
const encode=bytes=>{let text='';for(let at=0;at<bytes.length;at+=0x8000)text+=String.fromCharCode(...bytes.subarray(at,at+0x8000));return btoa(text);};
const decode=text=>Uint8Array.from(atob(text),ch=>ch.charCodeAt(0));
test('content codec preserves exact logical JSON, deterministic compressed encoding and legacy raw JSON',()=>{
 const kept=keepContentJson(json);assert.equal(kept.json_encoding,'json-gzip-base64/v1');assert.ok(kept.json.length<json.length/2);assert.deepEqual(keepContentJson(json),kept);
 assert.deepEqual(readContentJson(kept),JSON.parse(json));assert.deepEqual(readContentJson({json}),JSON.parse(json));assert.deepEqual(keepContentJson('null'),{json:'null'});
});
test('content codec refuses unknown encoding, forged lengths, corruption and trailing non-content before accepting decoded JSON',()=>{
 const kept=keepContentJson(json);
 for(const patch of [{json_encoding:'unknown'},{json_byte_length:0},{json_byte_length:CONTENT_JSON_MAX_BYTES+1},{json_byte_length:kept.json_byte_length-1},{json_byte_length:kept.json_byte_length+1},{json:'!bad'}])assert.throws(()=>readContentJson({...kept,...patch}));
 const bytes=decode(kept.json);bytes[Math.floor(bytes.length/2)]^=1;assert.throws(()=>readContentJson({...kept,json:encode(bytes)}));
 const footer=decode(kept.json);footer[footer.length-8]^=1;assert.throws(()=>readContentJson({...kept,json:encode(footer)}),/checksum/);
});
test('compressed bomb cannot exceed admitted decoded allocation even when gzip footer forges a small output bound',()=>{
 const bomb=gzipSync(new TextEncoder().encode(JSON.stringify('x'.repeat(2*1024*1024))),{mtime:0});bomb[bomb.length-4]=128;bomb[bomb.length-3]=bomb[bomb.length-2]=bomb[bomb.length-1]=0;
 assert.throws(()=>readContentJson({json:encode(bomb),json_encoding:'json-gzip-base64/v1',json_byte_length:128}),/exceeds|length|unexpected|invalid/i);
});

const payloadOf = bytes => ({json:encode(bytes),json_encoding:'json-gzip-base64/v1',json_byte_length:new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(bytes.length-4,true)});
test('codec retains previously admitted raw content above its compression bound',()=>{
 const original=JSON.stringify('x'.repeat(CONTENT_JSON_MAX_BYTES+1));
 assert.deepEqual(keepContentJson(original),{json:original});assert.equal(readContentJson({json:original}),JSON.parse(original));
});
test('codec accepts all JSON scalar forms and escaped Unicode without changing them',()=>{
 for(const original of ['null','true','123','""',JSON.stringify('é😎\ud800')])assert.deepEqual(readContentJson(keepContentJson(original)),JSON.parse(original));
});
test('codec refuses truncated gzip, multiple members and trailing bytes',()=>{
 const a=gzipSync(new TextEncoder().encode('"alpha"'),{mtime:0});
 const b=gzipSync(new TextEncoder().encode('"bravo"'),{mtime:0});
 const concat=new Uint8Array(a.length+b.length);concat.set(a);concat.set(b,a.length);
 assert.throws(()=>readContentJson(payloadOf(concat)));
 const garbage=new Uint8Array(a.length+8);garbage.set(a);garbage.set(a.subarray(a.length-8),a.length);
 assert.throws(()=>readContentJson(payloadOf(garbage)),/gzip|length|checksum|trailing/);
 assert.throws(()=>readContentJson({...payloadOf(a),json:encode(a.subarray(0,a.length-3))}));
});
test('codec refuses invalid UTF8 despite valid gzip length and checksum',()=>{
 const invalid=gzipSync(new Uint8Array([34,0xc0,0xaf,34]),{mtime:0});
 assert.throws(()=>readContentJson(payloadOf(invalid)),/encoded data|encoding|UTF/i);
});

test('large Unicode content survives encoder slice boundaries as one deterministic gzip member',()=>{
 const original=JSON.stringify({text:'x'.repeat(65533)+'😎é漢'.repeat(25000)+'y'.repeat(65537)});
 const kept=keepContentJson(original);
 assert.equal(kept.json_encoding,'json-gzip-base64/v1');
 assert.equal(kept.json_byte_length,new TextEncoder().encode(original).byteLength);
 assert.deepEqual(keepContentJson(original),kept);
 assert.deepEqual(readContentJson(kept),JSON.parse(original));
 const slicedPair=JSON.stringify('x'.repeat(32766)+'😎'+'y'.repeat(65536));
 assert.deepEqual(readContentJson(keepContentJson(slicedPair)),JSON.parse(slicedPair));
});

test('Unicode exceeding the UTF8 compression bound remains readable as original raw JSON',()=>{
 const original=JSON.stringify('😎'.repeat(CONTENT_JSON_MAX_BYTES/4+1));
 assert.ok(original.length<CONTENT_JSON_MAX_BYTES);
 assert.deepEqual(keepContentJson(original),{json:original});
 assert.equal(readContentJson({json:original}),JSON.parse(original));
});

test('complete segmented transcript survives compressed footer crossing the final decoder input slice',()=>{
 const fixture=segmentedTranscript(2_797_536),kept=keepContentJson(fixture.json);
 assert.equal(kept.json_encoding,'json-gzip-base64/v1');
 assert.deepEqual(readContentJson(kept),fixture.result);
});
