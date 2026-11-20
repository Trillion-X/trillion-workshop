import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProtectedActions } from '../read-data/records-door.mjs';

const reply = result => new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
async function descriptor(protectedActions, fetchImpl, run) {
  const root = tempFolder(join(tmpdir(), 'protected-native-door-'));
  const path = join(root, 'descriptor.json');
  writeFileSync(path, JSON.stringify({ url:'http://127.0.0.1:1/mcp',resource:'@synthetic-records',capability:'synthetic-native-capability',protected_actions:protectedActions }));
  try { return await run(() => openProtectedActions({ descriptor:path,fetchImpl,wait:async()=>{} })); }
  finally { rmSync(root,{recursive:true,force:true}); }
}
const route = {resource:'@synthetic-protected',operation:'protected:call',request_key:'original-native-operation'};

test('protected methods and existing records RPC share the original private descriptor', async () => {
  const calls = [];
  await descriptor(route, async (_url, init) => {
    const call = JSON.parse(init.body).params.arguments; calls.push(call);
    return reply({structuredContent:call.method==='records:read'?{type:'synthetic',value:{public:true}}:{accepted:true}});
  }, async open => {
    const door = open();
    assert.equal(door.requestKey,route.request_key);
    assert.deepEqual(await door.records.read('synthetic','synthetic:one'),{public:true});
    assert.deepEqual(await door.call('value.accept',{handle:'opaque-synthetic-handle'},'stable-callback-key'),{accepted:true});
  });
  assert.equal(calls[0].address,'@synthetic-records');
  assert.deepEqual(calls[1],{address:route.resource,method:route.operation,request_key:'stable-callback-key',input:{method:'value.accept',input:{handle:'opaque-synthetic-handle'}}});
});
test('an ordinary record descriptor cannot mint protected methods',async()=>{
  await descriptor(undefined,async()=>assert.fail('must not send'),async open=>{
    assert.throws(open,{code:'no_protected_actions'});
  });
});
test('protected effects never retry busy, unknown or lost acknowledgement',async()=>{
  for(const result of [{code:'selected_owner_unavailable',outcome:'not_started'},{code:'selected_owner_unavailable',outcome:'unknown'},null]){
    let calls=0;
    await descriptor(route,async()=>{calls++;if(!result)throw new TypeError('synthetic lost acknowledgement');return reply({isError:true,structuredContent:result});},async open=>{
      await assert.rejects(open().call('exchange',{callback_intake:'opaque-synthetic'},'original-exchange'));
      assert.equal(calls,1);
    });
  }
});
