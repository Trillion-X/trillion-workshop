import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceOfRow, namesDevice, factsShowDevice, handleDeviceRowsRequest } from '../read-data/device-rows.mjs';
const rules={legacy_rows:[{id_prefix:'camera-'}]};
test('a device field wins over legacy rows; whole model names match without matching a different model',()=>{
 assert.equal(deviceOfRow('camera-ILCE-7M4',{},rules),'ILCE-7M4');
 assert.equal(deviceOfRow('camera-ILCE-7M4',{device:''},rules),null);
 assert.equal(deviceOfRow('note',{device:' ilce-7m4 '},rules),'ILCE-7M4');
 assert.equal(deviceOfRow('note',{},rules),null);
 for(const text of ['SONY ILCE-7M4','FaceTime HD Camera, ILCE-7M4'])assert.equal(namesDevice(text,'ILCE-7M4'),true);
 for(const text of ['ILCE-7M4X','XILCE-7M4',null])assert.equal(namesDevice(text,'ILCE-7M4'),false);
 assert.equal(factsShowDevice([{facts:{camera:'Sony ILCE-7M4'}}],'ILCE-7M4'),true);
 assert.equal(namesDevice('a+b','a+b'),true);
});
test('the current account owner authorizes before enumeration; a rejected request reaches nothing',async()=>{
 let enumerated=false;
 const response=await handleDeviceRowsRequest(new Request('http://localhost/clean',{method:'POST'}),{authorized:async()=>false,accountsOnPage:async()=>{enumerated=true;}});
 assert.equal(response.status,403);assert.equal(enumerated,false);
});
test('bounded cleanup uses only the owner page, preserves dry mode, and reports failures separately',async()=>{
 const calls=[];
 const response=await handleDeviceRowsRequest(new Request('http://localhost/clean',{method:'POST',body:JSON.stringify({cursor:'page-2',dry:true})}),{
 authorized:async()=>true,
 accountsOnPage:async input=>{assert.deepEqual(input,{cursor:'page-2'});return {accounts:['a','b','c','d'],cursor:'page-3'};},
 cleanUpDeviceRows:async(account,{dry})=>{calls.push([account,dry]);if(account==='d')throw new Error('owner unavailable');return account==='a'?{would_clean:true,rows:['camera-x'],login_removed:false}:account==='b'?{cleaned:true,rows:['old'],login_removed:true}:{already:true};}
 });
 assert.deepEqual(calls,[['a',true],['b',true],['c',true],['d',true]]);
 assert.deepEqual(await response.json(),{walked:4,dry:true,cleaned:1,would_clean:1,already:1,accounts:[{account:'a',rows:['camera-x'],login_removed:false},{account:'b',rows:['old'],login_removed:true}],not_yet:[{account:'d',reason:'owner unavailable'}],cursor:'page-3'});
});
