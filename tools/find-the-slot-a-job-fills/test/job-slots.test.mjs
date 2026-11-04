import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {jobToolsIndex,toolsServing,slotTool} from '../src/job-slots.mjs';

function fixture(t){
 const host=sqliteHost(':memory:'),reads=[];t.after(()=>host.db.close());
 const sql={exec(query,...params){const cursor=host.sql.exec(query,...params);reads.push({query,params,rows:cursor.toArray().length});return cursor;}};
 const index=jobToolsIndex(sql);
 return {host,sql,reads,index,hold:(tool,holder,job='encode')=>{index.installed(holder,{context:'private',components:[{kind:'tool',id:tool}]});index.read(tool,holder,[job]);}};
}
const pages=(index,job,limit=64)=>{
 const result=[];let after=null;
 for(let call=0;call<2000;call++){const page=index.servingPage(job,{after,limit});result.push(page);if(page.complete)return result;assert.ok(page.next_after);assert.notDeepEqual(page.next_after,after);after=page.next_after;}
 assert.fail('Finite fixture cursor did not exhaust.');
};

test('more than500 duplicate holders cannot hide another tool from the complete serving ABI',t=>{
 const f=fixture(t);for(let n=0;n<620;n++)f.hold('tool:a',`install:${String(n).padStart(5,'0')}`);
 f.index.saved({id:'tool:b',serves:['encode']});f.index.saved({id:'tool:z',serves:['encode']});
 assert.deepEqual(f.index.serving('encode'),['tool:a','tool:b','tool:z']);
 const chain=pages(f.index,'encode');assert.deepEqual(chain.flatMap(page=>page.ids),['tool:a','tool:b','tool:z']);
 assert.equal(chain.at(-1).complete,true);assert.equal(chain.at(-1).next_after,null);
 assert.ok(f.reads.filter(row=>/^SELECT tool_id, held_by FROM job_tools WHERE/.test(row.query)).every(row=>row.rows<=65));
});

test('empty distinct-id pages remain nonterminal and advance through duplicate physical holders',t=>{
 const f=fixture(t);for(let n=0;n<9;n++)f.hold('tool:a',`install:${n}`);f.index.saved({id:'tool:b',serves:['encode']});
 const chain=pages(f.index,'encode',2);assert.deepEqual(chain[0].ids,['tool:a']);
 assert.ok(chain.some(page=>page.ids.length===0&&!page.complete&&page.next_after));
 assert.deepEqual(chain.flatMap(page=>page.ids),['tool:a','tool:b']);assert.deepEqual(f.index.serving('encode'),['tool:a','tool:b']);
});

test('the full serving compatibility result preserves every one of more than500 distinct tools',t=>{
 const f=fixture(t),expected=Array.from({length:701},(_,n)=>`tool:${String(n).padStart(4,'0')}`);
 for(const id of expected)f.index.saved({id,serves:['encode']});
 assert.deepEqual(f.index.serving('encode'),expected);assert.deepEqual(pages(f.index,'encode',200).flatMap(page=>page.ids),expected);
});

test('the physical page boundary proves exhaustion without losing the first id after it',t=>{
 const f=fixture(t);for(let n=0;n<64;n++)f.index.saved({id:`tool:${String(n).padStart(3,'0')}`,serves:['encode']});
 const complete=f.index.servingPage('encode');assert.equal(complete.ids.length,64);assert.equal(complete.complete,true);assert.equal(complete.next_after,null);
 f.index.saved({id:'tool:064',serves:['encode']});const first=f.index.servingPage('encode');assert.equal(first.complete,false);assert.equal(first.ids.length,64);
 const last=f.index.servingPage('encode',{after:first.next_after});assert.deepEqual(last.ids,['tool:064']);assert.equal(last.complete,true);assert.equal(f.index.serving('encode').length,65);
});

test('first-page seeking retains empty string keys accepted by the original source contract',t=>{
 const f=fixture(t);f.index.saved({id:'',serves:['']});f.index.saved({id:'tool:a',serves:['']});
 const chain=pages(f.index,'',1);assert.deepEqual(chain.flatMap(page=>page.ids),['','tool:a']);assert.deepEqual(f.index.serving(''),['','tool:a']);
});

test('page inputs cannot request unbounded rows or reuse another job cursor',t=>{
 const f=fixture(t);for(const limit of [0,-1,201,1.5,NaN])assert.throws(()=>f.index.servingPage('encode',{limit}),/between 1 and 200/);
 assert.throws(()=>f.index.servingPage('encode',{after:{job:'other',tool_id:'tool:a',held_by:'install:a'}}),/exact job-tool/);
 assert.throws(()=>f.index.servingPage('encode',{after:{job:'encode',tool_id:'tool:a',held_by:'install:a',offset:10}}),/exact job-tool/);
 assert.deepEqual(f.index.servingPage('encode',{limit:200}),{ids:[],complete:true,next_after:null});
});

test('saved replacement/deletion and independent installed holders preserve exact job membership',t=>{
 const f=fixture(t);f.index.saved({id:'tool:a',serves:['encode','encode','other']});f.hold('tool:a','install:a');
 assert.deepEqual(f.index.serving('encode'),['tool:a']);f.index.saved({id:'tool:a',serves:['other']});assert.deepEqual(f.index.serving('encode'),['tool:a']);
 f.index.installed('install:a',{removed_at:'now',context:'private',components:[]});assert.deepEqual(f.index.serving('encode'),[]);assert.deepEqual(f.index.serving('other'),['tool:a']);
 f.index.saved({id:'tool:a',status:'deleted',serves:['other']});assert.deepEqual(f.index.serving('other'),[]);
});

test('unread descriptor semantics and existing default50 remain unchanged',t=>{
 const f=fixture(t);f.index.installed('install:a',{context:'private',components:Array.from({length:70},(_,n)=>({kind:'tool',id:`tool:${String(n).padStart(3,'0')}`})),without:['tool:069']});
 assert.equal(f.index.unread().length,50);assert.equal(f.index.unread(2).length,2);assert.deepEqual(f.index.unread(0),[]);
 for(const limit of [-1,201,1.5,NaN])assert.throws(()=>f.index.unread(limit),/between 0 and 200/);
 const first=f.index.unread(1)[0];f.index.read(first.tool_id,first.held_by,null);assert.deepEqual(f.index.unread(1)[0],first);
 f.index.read(first.tool_id,first.held_by,[]);assert.notDeepEqual(f.index.unread(1)[0],first);
});

test('a selected physical page stays bounded as unrelated job rows grow fourfold and uses the keyset index',t=>{
 const measurements=[];
 for(const size of [300,1200]){
  const f=fixture(t);for(let n=0;n<size;n++)f.index.saved({id:`tool:unrelated:${n}`,serves:['other']});
  for(let n=0;n<130;n++)f.hold(`tool:${String(n).padStart(3,'0')}`,`install:${n}`);
  const first=f.index.servingPage('encode');f.reads.length=0;
  const second=f.index.servingPage('encode',{after:first.next_after});assert.equal(second.ids.length,64);
  measurements.push(f.reads.map(read=>({rows:read.rows,limit:read.params.at(-1)})));
  const plan=f.host.sql.exec('EXPLAIN QUERY PLAN SELECT tool_id, held_by FROM job_tools WHERE job = ? AND (tool_id, held_by) > (?, ?) ORDER BY tool_id, held_by LIMIT ?','encode',first.next_after.tool_id,first.next_after.held_by,65).toArray();
  assert.ok(plan.some(row=>/SEARCH job_tools/.test(row.detail)),JSON.stringify(plan));assert.ok(plan.every(row=>!/SCAN job_tools|TEMP B-TREE/.test(row.detail)),JSON.stringify(plan));
 }
 assert.deepEqual(measurements[0],measurements[1]);assert.deepEqual(measurements[0],[{rows:65,limit:65}]);
});

test('cold owner reconstruction replays the same physical cursor and complete distinct output',t=>{
 const directory=mkdtempSync(join(tmpdir(),'trillion-job-tools-')),file=join(directory,'jobs.sqlite');let host=sqliteHost(file);
 t.after(()=>{host.db.close();rmSync(directory,{recursive:true,force:true});});let index=jobToolsIndex(host.sql);
 for(let n=0;n<620;n++){const held=`install:${String(n).padStart(4,'0')}`;index.installed(held,{context:'private',components:[{kind:'tool',id:'tool:a'}]});index.read('tool:a',held,['encode']);}
 index.saved({id:'tool:z',serves:['encode']});const first=index.servingPage('encode'),next=index.servingPage('encode',{after:first.next_after});
 host.db.close();host=sqliteHost(file);index=jobToolsIndex(host.sql);
 assert.deepEqual(index.servingPage('encode',{after:first.next_after}),next);assert.deepEqual(index.serving('encode'),['tool:a','tool:z']);
});

test('pure slot selection retains installed membership, choice, rank and deterministic tie order',()=>{
 const tools=[{id:'tool:z',serves:['encode'],rank:1},{id:'tool:a',serves:['encode'],rank:1},{id:'tool:b',serves:['other'],rank:9}],set=new Set(tools.map(tool=>tool.id));
 assert.deepEqual(toolsServing('encode',set,tools,{rank:tool=>tool.rank}).map(tool=>tool.id),['tool:a','tool:z']);
 assert.equal(slotTool('encode',set,tools,{choice:'tool:z',rank:tool=>tool.rank}).id,'tool:z');set.delete('tool:z');assert.equal(slotTool('encode',set,tools,{choice:'tool:z'}).id,'tool:a');
});

test('unread physical continuation reaches later tools behind nulls and excludes extensions beyond its finite boundary', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const reads = [], sql = { exec(query, ...params) { const cursor = host.sql.exec(query, ...params); reads.push({ query, params, rows: cursor.toArray().length }); return cursor; } };
  const index = jobToolsIndex(sql), ids = Array.from({ length: 51 }, (_, n) => `tool:${String(n).padStart(3, '0')}`);
  index.installed('install:a', { context: 'private', components: ids.map(id => ({ kind: 'tool', id })) });
  const through = index.unreadBoundary(), first = index.unreadPage({ through });
  assert.equal(first.rows.length, 50); assert.equal(first.complete, false);
  for (const row of first.rows) index.read(row.tool_id, row.held_by, null);
  index.installed('install:z', { context: 'private', components: [{ kind: 'tool', id: 'tool:added-after-boundary' }] });
  const second = index.unreadPage({ through, after: first.next_after });
  assert.deepEqual(second.rows.map(row => ({ ...row })), [{ held_by: 'install:a', tool_id: ids[50] }]);
  assert.equal(second.complete, true); assert.equal(second.next_after, null);
  index.read(second.rows[0].tool_id, second.rows[0].held_by, ['encode']);
  assert.deepEqual(index.serving('encode'), [ids[50]]);
  assert.equal(index.unread(200).length, 51, 'all nulls and the later extension remain retryable');
  assert.ok(reads.filter(row => /SELECT held_by, tool_id FROM job_tools_unread/.test(row.query)).every(row => row.rows <= 51));
  const plan = host.sql.exec('EXPLAIN QUERY PLAN SELECT held_by, tool_id FROM job_tools_unread WHERE (held_by, tool_id) > (?, ?) AND (held_by, tool_id) <= (?, ?) ORDER BY held_by, tool_id LIMIT ?', first.next_after.held_by, first.next_after.tool_id, through.held_by, through.tool_id, 51).toArray();
  assert.ok(plan.some(row => /SEARCH job_tools_unread/.test(row.detail)), JSON.stringify(plan));
  assert.ok(plan.every(row => !/TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
});

test('the original unread boundary and physical continuation survive disk owner reconstruction', t => {
  const directory = mkdtempSync(join(tmpdir(), 'trillion-unread-')), file = join(directory, 'jobs.sqlite');
  let host = sqliteHost(file); t.after(() => { host.db.close(); rmSync(directory, { recursive: true, force: true }); });
  let index = jobToolsIndex(host.sql);
  index.installed('install:a', { context: 'private', components: Array.from({ length: 70 }, (_, n) => ({ kind: 'tool', id: `tool:${String(n).padStart(3, '0')}` })) });
  const through = index.unreadBoundary(), first = index.unreadPage({ through }), expected = index.unreadPage({ through, after: first.next_after });
  host.db.close(); host = sqliteHost(file); index = jobToolsIndex(host.sql);
  assert.deepEqual(index.unreadPage({ through, after: first.next_after }), expected);
  for (const limit of [0, -1, 201, NaN, 1.5]) assert.throws(() => index.unreadPage({ through, limit }), /finite unread/);
  assert.throws(() => index.unreadPage({ through: null }), /finite unread/);
});
