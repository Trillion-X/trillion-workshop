import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDraftOperations} from '../summarize-draft-operations.mjs';
const at=n=>new Date(Date.UTC(2026,8,13,0,0,n)).toISOString();
const event=(state,n)=>({state,at:at(n)});

test('data-defined names and an empty scope remain safe literal values',()=>{
 const summary=summarizeDraftOperations([{id:'one',parent_id:'',state:'constructor',disposition:'__proto__',events:[event('__proto__',0),event('constructor',2)]},{id:'other',parent_id:'other',state:'complete'}],{parentId:''});
 assert.equal(summary.record_count,1);assert.equal(summary.by_state.constructor,1);assert.equal(summary.by_disposition.__proto__,1);assert.equal(summary.timings.closed_states.__proto__.total_ms,2000);
 assert.equal(Object.getPrototypeOf(summary.by_disposition),Object.prototype);
});

test('actual transitions measure queue, planning, rendering and later review separately',()=>{
 const record={id:'one',parent_id:'a',state:'complete',disposition:'approved',events:[event('queued',0),event('planning',2),event('rendering',7),event('complete',17),{disposition:'approved',at:at(30)}]};
 const summary=summarizeDraftOperations([record]);
 assert.deepEqual(summary.by_state,{complete:1});assert.deepEqual(summary.by_disposition,{approved:1});
 assert.equal(summary.timings.closed_states.queued.total_ms,2000);assert.equal(summary.timings.closed_states.planning.total_ms,5000);assert.equal(summary.timings.closed_states.rendering.total_ms,10000);assert.equal(summary.timings.queued_to_first_complete.mean_ms,17000);assert.equal(summary.timings.first_complete_to_first_disposition.mean_ms,13000);
 assert.ok(summary.unavailable.some(item=>item.metric==='render_resource_use_and_waste'));
});

test('missing and invalid history never borrows created or updated times',()=>{
 const summary=summarizeDraftOperations([{id:'legacy',state:'complete',created_at:at(0),updated_at:at(50)},{id:'bad',state:'complete',events:[event('queued',10),event('complete',5)]},{id:'missing',state:'complete',events:[event('queued',0),{state:'planning'},event('complete',20)]}]);
 assert.equal(summary.record_count,3);assert.equal(summary.coverage.records_without_events,1);assert.equal(summary.coverage.records_with_invalid_history,2);assert.equal(summary.timings.queued_to_first_complete.available,false);assert.equal(summary.timings.queued_to_first_complete.total_ms,null);assert.deepEqual(summary.timings.closed_states,{});
});

test('retry intervals retain failures, cancelled records and explicit observation without inventing completion',()=>{
 const record={id:'retry',state:'rendering',events:[event('queued',0),event('planning',1),event('failed',4),event('queued',9),event('planning',10),event('rendering',12)]};
 const summary=summarizeDraftOperations([record,{id:'cancel',state:'cancelled',events:[event('queued',0),event('cancelled',2)]}],{now:at(20)});
 assert.equal(summary.state_event_counts.queued,3);assert.equal(summary.timings.closed_states.planning.total_ms,5000);assert.equal(summary.timings.closed_states.failed.total_ms,5000);assert.equal(summary.drafts[0].open_interval.elapsed_ms,8000);assert.equal(summary.drafts[1].open_interval,null);assert.equal(summary.timings.queued_to_first_complete.samples,0);
 assert.equal(summarizeDraftOperations([record]).drafts[0].open_interval,null);
});

test('scope, duplicates, identity gaps and repeated state records cannot inflate measurements',()=>{
 const a={id:'a',parent_id:'scope',state:'complete',events:[event('queued',0),event('queued',1),event('complete',5)]};
 const summary=summarizeDraftOperations([a,a,{parent_id:'scope',state:'failed'},{id:'foreign',parent_id:'other',state:'complete'}],{parentId:'scope'});
 assert.equal(summary.record_count,1);assert.equal(summary.coverage.duplicate_records,1);assert.equal(summary.coverage.records_without_identity,1);assert.equal(summary.timings.closed_states.queued.total_ms,5000);assert.deepEqual(summary.by_state,{complete:1});assert.equal(summary.state_event_counts.queued,1);
});
