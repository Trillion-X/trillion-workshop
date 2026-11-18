// Old trillion test/native-domain-consumers.test.mjs (tag old-trillion-before-worker-retire), its two tests of
// src/native-calendar-owner.mjs (lines 25-46), unchanged; its other tests are of src/own-resource-compatibility.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCalendarOwner} from '../src/native-calendar-owner.mjs';

test('Calendar connection discovery retains the current selection record',async()=>{
 const selections=[],seen=[];
 const owner=nativeCalendarOwner({records:{read:id=>{seen.push(id);return selections;}},workshop:{run:async()=>({state:'completed',output:{}})},route:async()=>({}),
  sources:[],settings:{sources:[]},connectionIO:{connections:async()=>[],bind:async()=>{throw Error('No connection should bind.');},runTool:async()=>{throw Error('No provider call should run.');}},current:async op=>seen.push(op)});
 const result=await owner.operations['calendar:request']({path:'/calendar/connections',method:'GET'});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.selections,selections);
 assert.ok(seen.includes('calendar:request'));
 assert.ok(seen.includes('workspace-preference:calendar-selections'));
});
