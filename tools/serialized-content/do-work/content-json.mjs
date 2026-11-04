// Lossless bounded JSON content representation. The record owner seals `json` normally (erasable format v1).
// No Node API: the same codec runs in Workers, native Node and browser bundles.
import { gzipSync, Gunzip } from 'fflate';
import { base64Of } from './base64.mjs';
const ENCODING = 'json-gzip-base64/v1';
export const CONTENT_JSON_MAX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = new Uint32Array(256);
for (let n=0;n<256;n++) { let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0; }
const crcUpdate=(crc,bytes)=>{for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0;};
const u32=(bytes,at)=>(bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16|bytes[at+3]<<24)>>>0;
const refusal=message=>Object.assign(new Error(message),{code:'content_json_invalid'});
/** Encode exact original serialized JSON; unknown formats are never guessed on read. */
export function keepContentJson(json) {
 if(typeof json!=='string')throw refusal('Serialized content must be JSON text.');
 const bytes=encoder.encode(json);
 // Existing raw records have their own caller admission; the codec must not narrow it.
 if(bytes.byteLength>CONTENT_JSON_MAX_BYTES)return{json};
 if(bytes.byteLength<4096)return{json};
 // One whole-buffer pass. Streaming it in 32K slices through fflate's Gzip raised the Workerd peak for a 2.8 MB
 // transcript result from under 48 MB to 51 MB (test/handoff-result-segmented-isolated-workerd.test.mjs, 2026-10-13).
 const zipped=gzipSync(bytes,{level:1,mtime:0});
 // Base64 is the plaintext that the existing erasable owner seals. Avoid a larger representation.
 if(Math.ceil(zipped.byteLength/3)*4+96>=bytes.byteLength)return{json};
 return{json:base64Of(zipped),json_encoding:ENCODING,json_byte_length:bytes.byteLength};
}
/** Bounded exact decompression, then JSON.parse; old raw-json records remain valid. */
export function readContentJson(payload) {
 if(!payload||typeof payload.json!=='string')throw refusal('Saved serialized content is unavailable.');
 if(payload.json_encoding===undefined){
  return JSON.parse(payload.json);
 }
 if(payload.json_encoding!==ENCODING)throw refusal('Unknown serialized content encoding.');
 const expected=payload.json_byte_length;
 if(!Number.isSafeInteger(expected)||expected<1||expected>CONTENT_JSON_MAX_BYTES)throw refusal('Invalid serialized content decode bound.');
 const text=payload.json;
 if(!text.length||text.length>Math.ceil(CONTENT_JSON_MAX_BYTES/3)*4||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw refusal('Invalid serialized content bytes.');
 let binary;try{binary=atob(text);}catch{throw refusal('Invalid serialized content base64.');}
 const zipped=new Uint8Array(binary.length);for(let at=0;at<binary.length;at++)zipped[at]=binary.charCodeAt(at);
 // Our one-member gzip envelope has no optional header fields. The footer is admitted before output allocation.
 if(zipped.length<18||zipped[0]!==31||zipped[1]!==139||zipped[2]!==8||zipped[3]!==0||u32(zipped,zipped.length-4)!==expected)throw refusal('Invalid serialized content gzip envelope.');
 const bytes=new Uint8Array(expected);let used=0,crc=0xffffffff,ended=false;
 const unzip=new Gunzip((chunk,final)=>{
  if(chunk.byteLength>expected-used)throw refusal('Serialized content exceeds its exact decoded length.');
  bytes.set(chunk,used);used+=chunk.byteLength;crc=crcUpdate(crc,chunk);if(final)ended=true;
 });
 unzip.onmember=()=>{throw refusal('Serialized content must contain one gzip member.');};
 // Include the footer with the final DEFLATE bytes. Gunzip otherwise starts
 // looking for another member when the first ends in a non-final input slice.
 // Slices remain at most 1,032 bytes; no claimed gzip length controls allocation.
 for(let at=0;at<zipped.length;){
  const end=at+1024>=zipped.length-8?zipped.length:at+1024;
  unzip.push(zipped.subarray(at,end),end===zipped.length);at=end;
 }
 // fflate 0.8.2 leaves the final partial DEFLATE byte plus the gzip footer in `p`.
 // Its public Gunzip API accepts extra bytes on a final push. This version-pinned
 // adapter verifies its consumed boundary as well as CRC/ISIZE; dependency
 // upgrades must pass the truncated/member/trailing witnesses before changing it.
 const footerBytes=8+(unzip.s.p?1:0);
 if(!unzip.s.f||unzip.s.l||unzip.p.byteLength!==footerBytes)throw refusal('Serialized content has trailing or unfinished gzip bytes.');
 if(!ended||used!==expected||((crc^0xffffffff)>>>0)!==u32(zipped,zipped.length-8))throw refusal('Serialized content length or checksum differs.');
 return JSON.parse(decoder.decode(bytes));
}
