import test from 'node:test';
import assert from 'node:assert/strict';
import { completeActions } from '../do-work/complete-actions.mjs';
import { noticeAttention } from '../../notice-what-needs-attention/do-work/notice-attention.mjs';
import attentionSettings from '../../notice-what-needs-attention/src/attention.json' with { type: 'json' };
import { inspectDeviceRows } from '../../leave-out-steps-for-devices-i-do-not-own/do-work/inspect-device-rows.mjs';
import { checkHeardEcho } from '../../tell-our-own-voice-from-what-was-heard/do-work/check-heard-echo.mjs';
import { checkImportedHistoryReceipt } from '../../carry-an-account-into-its-own-records/do-work/imported-history-receipt.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
const policy={id:'standard:test',version:2,workflow_id:'workflow:test',label:'Test',instruction:'Use every action.',plan:'Plan each path.',proof:'Observe the results.',core_actions:['read','edit'],exclusion_kinds:[],additional_action_examples:[],guard_step_ids:{inventory:'inventory',proof:'proof'},limits:{surfaces:2,operations:5,extra_actions_per_surface:2}};
const doorFor=rows=>({async read(type,id){assert.equal(type,'record:content-setting');assert.ok(Object.hasOwn(rows,id),id);return rows[id];}});
test('the action tool reads opinion rows through the door and preserves an unrelated recipe',async()=>{
 const door=doorFor({'record:content-setting:action-completeness':policy,'record:content-setting:execution-mode-records':{records:[]}});
 assert.equal((await completeActions({}, {door})).id,'workflow:test');
 const recipe={id:'unrelated',steps:[]};assert.equal(await completeActions({operation:'decorate',recipe},{door}),recipe);
 await assert.rejects(completeActions({}, {door:doorFor({'record:content-setting:action-completeness':null})}),/policy row/);
});
test('the attention tool uses current formulas, caller history policy and speaker ownership without a model',async()=>{
 const door=doorFor({'record:content-setting:attention':attentionSettings,'record:content-setting:brought-in':{history_after_minutes:60}});
 const arrival={text:'Book the dentist',at:'2026-11-08T01:00:00Z',recorded_at:'2026-11-08T12:00:00Z'};
 assert.equal((await noticeAttention({arrival},{door})).attention,'context');
 const result=await noticeAttention({arrival:{text:'Please call me',heard:true,verdict:'act'}},{door});
 assert.equal(result.arrival.from_person,false);assert.equal(result.arrival.from,'An unknown voice');
 const live=await noticeAttention({arrival:{text:'Book the dentist'}},{door});assert.equal(live.attention,'act');assert.equal(live.opens,true);
});
test('the device tool hides only with complete successful evidence and preserves unrelated rows',async()=>{
 const rows=[{id:'camera-x',values:{}},{id:'note',values:{}}];
 const door=doorFor({'record:content-setting:waiting-on-you-devices':{legacy_rows:[{id_prefix:'camera-'}]}});
 assert.deepEqual(await inspectDeviceRows({rows},{door}),{shown:rows,hidden:[]});
 assert.deepEqual(await inspectDeviceRows({rows,evidence_complete:true},{door}),{shown:[rows[1]],hidden:[rows[0]]});
 assert.deepEqual(await inspectDeviceRows({rows,evidence_complete:true,reports:[{facts:{model:'x'}}]},{door}),{shown:rows,hidden:[]});
});
test('echo tool reads account configuration through the door and requires actual kept notices',async()=>{
 const settings={spoken:{words:{say:'{title} {body}',ask:'Do you want to answer'},longest_body:100},skip_word:'[0-9]',window_before_hours:1,window_after_minutes:1,min_words:4,gram:2,threshold:.8,matched_words_most:10,stopwords:[],min_word_letters:3,min_content_words:4,min_found:4,word_share:.8,word_window_before_minutes:5,word_window_after_minutes:1,sources:{notice:'notice {seq}',ask:'ask'},evidence:'{source} {matched}',word_evidence:'{source} {matched}'};
 const notification_rows={channels:[{id:'voice',can:['speak']}],kinds:[{id:'update',channels:{every:true,except:[]}}],default_kind:'update'};
 const door=doorFor({'record:content-setting:heard-echo':settings,'record:content-setting:tell-the-person':notification_rows});
 const notice={kind:'update',seq:7,at:'2026-11-08T12:00:00Z',title:'',body:'The recording finished and the transcript is ready'};
 const result=await checkHeardEcho({notices:[notice],text:notice.body,at:'2026-11-08T12:00:01Z'},{door});assert.equal(result.echo.notice.seq,7);
 await assert.rejects(checkHeardEcho({text:notice.body,at:0},{door}),/actually kept/);
});
test('history receipt verifies exact bytes through the file door and refuses a changed receipt without reading files',async()=>{
 const bytes=Buffer.from('a kept history page');
 const receipt=await checkImportedHistoryReceipt({operation:'create',import:{run:'import-1',archives:[{key:'history/a',first_id:'a',bytes:bytes.length,identity:makeHashCodeHexFromBytes(bytes)}]}});
 const calls=[];
 const door={async files(method,input){calls.push(method);assert.equal(input.name_or_identity,'history/a');if(method==='find_file')return {names:['history/a']};return {content:bytes.toString('base64'),encoding:'base64',bytes_returned:bytes.length,byte_length:bytes.length};}};
 assert.deepEqual(await checkImportedHistoryReceipt({operation:'verify',receipt},{door}),{verified:true});
 assert.deepEqual(calls,['find_file','read_file']);calls.length=0;
 assert.deepEqual(await checkImportedHistoryReceipt({operation:'verify',receipt:{...receipt,head:'changed'}},{door}),{verified:false});assert.deepEqual(calls,[]);
});
