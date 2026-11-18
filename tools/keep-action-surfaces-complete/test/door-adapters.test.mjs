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
test('the action tool takes its opinion rows as input and preserves an unrelated recipe',async()=>{
 const modes={records:[]};
 assert.equal((await completeActions({policy})).id,'workflow:test');
 const recipe={id:'unrelated',steps:[]};assert.equal(await completeActions({operation:'decorate',recipe,policy,modes}),recipe);
 await assert.rejects(completeActions({operation:'decorate',recipe,policy}),/execution-mode rows/);
 await assert.rejects(completeActions({}),/policy row/);
});
test('the attention tool uses current formulas, input history policy and speaker ownership without a model',async()=>{
 const given={settings:attentionSettings,history:{history_after_minutes:60}};
 const arrival={text:'Book the dentist',at:'2026-11-08T01:00:00Z',recorded_at:'2026-11-08T12:00:00Z'};
 assert.equal((await noticeAttention({...given,arrival})).attention,'context');
 const result=await noticeAttention({...given,arrival:{text:'Please call me',heard:true,verdict:'act'}});
 assert.equal(result.arrival.from_person,false);assert.equal(result.arrival.from,'An unknown voice');
 const live=await noticeAttention({...given,arrival:{text:'Book the dentist'}});assert.equal(live.attention,'act');assert.equal(live.opens,true);
});
test('the device tool hides only with complete successful evidence and preserves unrelated rows',async()=>{
 const rows=[{id:'camera-x',values:{}},{id:'note',values:{}}];
 const rules={legacy_rows:[{id_prefix:'camera-'}]};
 assert.deepEqual(await inspectDeviceRows({rows,rules}),{shown:rows,hidden:[]});
 assert.deepEqual(await inspectDeviceRows({rows,rules,evidence_complete:true}),{shown:[rows[1]],hidden:[rows[0]]});
 assert.deepEqual(await inspectDeviceRows({rows,rules,evidence_complete:true,reports:[{facts:{model:'x'}}]}),{shown:rows,hidden:[]});
});
test('echo tool takes its configuration as input and requires actual kept notices',async()=>{
 const settings={spoken:{words:{say:'{title} {body}',ask:'Do you want to answer'},longest_body:100},skip_word:'[0-9]',window_before_hours:1,window_after_minutes:1,min_words:4,gram:2,threshold:.8,matched_words_most:10,stopwords:[],min_word_letters:3,min_content_words:4,min_found:4,word_share:.8,word_window_before_minutes:5,word_window_after_minutes:1,sources:{notice:'notice {seq}',ask:'ask'},evidence:'{source} {matched}',word_evidence:'{source} {matched}'};
 const notification_rows={channels:[{id:'voice',can:['speak']}],kinds:[{id:'update',channels:{every:true,except:[]}}],default_kind:'update'};
 const notice={kind:'update',seq:7,at:'2026-11-08T12:00:00Z',title:'',body:'The recording finished and the transcript is ready'};
 const result=await checkHeardEcho({settings,notification_rows,notices:[notice],text:notice.body,at:'2026-11-08T12:00:01Z'});assert.equal(result.echo.notice.seq,7);
 await assert.rejects(checkHeardEcho({settings,notification_rows,text:notice.body,at:0}),/actually kept/);
});
test('history receipt verifies exact bytes handed in and refuses a changed receipt without reading any archive',async()=>{
 const bytes=Buffer.from('a kept history page');
 const receipt=await checkImportedHistoryReceipt({operation:'create',import:{run:'import-1',archives:[{key:'history/a',first_id:'a',bytes:bytes.length,identity:makeHashCodeHexFromBytes(bytes)}]}});
 const calls=[];
 const archives=async key=>{calls.push(key);assert.equal(key,'history/a');return bytes;};
 assert.deepEqual(await checkImportedHistoryReceipt({operation:'verify',receipt},{archives}),{verified:true});
 assert.deepEqual(calls,['history/a']);calls.length=0;
 assert.deepEqual(await checkImportedHistoryReceipt({operation:'verify',receipt:{...receipt,head:'changed'}},{archives}),{verified:false});assert.deepEqual(calls,[]);
});
