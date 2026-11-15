import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeardEcho } from '../read-data/heard-echo.mjs';
const config={spoken:{words:{say:'{title} {body}',ask:'Would you like to answer now'},longest_body:200},skip_word:'[0-9]',window_before_hours:1,window_after_minutes:1,min_words:4,gram:2,threshold:.8,matched_words_most:20,stopwords:['the','a','to','and','you'],min_word_letters:3,min_content_words:4,min_found:4,word_share:.8,word_window_before_minutes:5,word_window_after_minutes:1,sources:{notice:'notice {seq} {key} {kind} {at}',ask:'ask',answer_said:'answer'},evidence:'{share}% {source} {matched}',word_evidence:'{found}/{count} {share}% {source} {matched}'};
const rows={channels:[{id:'speaker',can:['speak']},{id:'screen',can:['show']}],kinds:[{id:'update',channels:['speaker']}],default_kind:'update',spoken_answers:{later:{said:'We can answer later'},stop:{said:'I have stopped speaking'}}};
const kindChannels=(kind,channels)=>Array.isArray(kind.channels)?kind.channels:kind.channels?.every?channels.map(row=>row.id).filter(id=>!(kind.channels.except??[]).includes(id)):[];
const api=createHeardEcho({data:config,tellRows:rows,kindChannels});
const at=Date.parse('2026-11-08T12:00:00Z');
const notice={seq:1,key:'one',kind:'update',at:new Date(at-60000).toISOString(),title:'Camera repair complete',body:'Your studio camera firmware upgrade finished successfully'};
test('a heard fragment is credited by matched runs with its notice evidence; unrelated words are not an echo',()=>{
 const found=api.echoOf('studio camera firmware upgrade finished successfully',at,[notice]);
 assert.equal(found.rule,'runs');assert.equal(found.notice.key,'one');assert.equal(found.share,1);assert.match(found.evidence,/firmware upgrade/);
 assert.equal(api.echoOf('Please call the dentist tomorrow and book an appointment',at,[notice]),null);
 assert.deepEqual(api.wordsOf('Camera 123, ILCE7 studio'),['camera','studio']);
});
test('failed or unknown speech receipts cannot prove an echo; old notices retain the source capability fallback',()=>{
 for(const result of [{sent:false},{},null])assert.equal(api.echoOf(notice.body,at,[{...notice,results:{speaker:result}}]),null);
 assert.equal(api.echoOf(notice.body,at,[{...notice,results:{speaker:{sent:true}}}]).notice.key,'one');
 assert.equal(api.echoOf(notice.body,at,[{...notice,at:new Date(at-2*3600000).toISOString()}]),null);
});
test('scrambled content words need one nearby notice and cannot borrow words from several notices',()=>{
 const text='successfully firmware studio finished upgrade camera';
 assert.equal(api.echoOf(text,at,[notice]).rule,'words');
 const separate=[{...notice,title:'',body:'studio firmware camera'},{...notice,seq:2,title:'',body:'upgrade finished successfully'}];
 assert.equal(api.echoOf(text,at,separate),null);
 assert.equal(api.echoOf(text,at,[{...notice,at:new Date(at-10*60000).toISOString()}]),null);
});
test('different caller rows and thresholds remain isolated',()=>{
 const other=createHeardEcho({data:{...config,min_words:100,min_content_words:100},tellRows:rows,kindChannels});
 assert.equal(other.echoOf(notice.body,at,[notice]),null);assert.ok(api.echoOf(notice.body,at,[notice]));
});
