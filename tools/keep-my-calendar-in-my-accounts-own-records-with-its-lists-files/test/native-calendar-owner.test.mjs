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

// 2026-10-20: every work resource's scheduler ran the recurrence step, which made the built-in calendar lists in it.
test('a work resource with no task list schedules no recurrence and its step makes no list',async()=>{
 const writes=[],lists={has:()=>false,ensure:()=>{throw Error('No calendar list should be made.');},save:()=>{throw Error('No calendar list should be saved.');},read:()=>{throw Error('No task list should be read.');}};
 const owner=nativeCalendarOwner({records:{read:()=>null},workshop:{run:async()=>({})},route:async()=>({}),taskListOwner:lists,
  stateRead:async()=>null,stateWrite:async value=>writes.push(value)});
 assert.equal(await owner.recurrenceNextAt(),null);
 assert.deepEqual(writes,[],'no recurrence state is written');
 const page=await owner.recurrenceStep();
 assert.deepEqual({complete:page.complete,created:page.created},{complete:true,created:0});
});
