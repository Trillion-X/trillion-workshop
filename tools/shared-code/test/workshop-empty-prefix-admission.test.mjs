// Ported from old trillion test/workshop-empty-prefix-admission.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The first test is the old one over src/workshop-facts.mjs here. The second booked a whole
// old person store (test/person-store-reads-for-tests.mjs personStoreOver over src/person-store.mjs) to publish and take work
// while the Workshop projection was unfinished; that store went with the Worker and nothing composes agents over workshop facts
// now (searched personStoreOver, marketplaceInstallations in trillion-workshop tools/, trillion-rust src/, trillion-apps web/),
// so it is left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {workshopValues,addWorkshopFact,forgetWorkshopFacts} from '../src/workshop-facts.mjs';
function facts(){const host=sqliteHost(':memory:');host.sql.exec('CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL)');host.sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq)');host.transaction(()=>{for(let n=0;n<200;n++)host.sql.exec('INSERT INTO workshop_facts(at,entity,value) VALUES(?,?,?)','2026-10-10',`tool:${String(n).padStart(3,'0')}`,JSON.stringify({id:'tool:'+n}));});return host;}

test('an absent requested prefix is known without global fill, and later writes are never missed',()=>{
 const host=facts();const read=[];const sql={exec(query,...params){read.push({query,params});return host.sql.exec(query,...params);}};
 assert.deepEqual(workshopValues(sql,'agent:'),[]);
 assert.equal(read.length,1,'one indexed raw existence probe, no schema or migration work');
 assert.match(read[0].query,/entity >= \? AND entity < \? LIMIT 1/);
 const plan=host.sql.exec('EXPLAIN QUERY PLAN '+read[0].query,...read[0].params).toArray();assert.ok(plan.some(row=>/SEARCH workshop_facts USING COVERING INDEX workshop_facts_current/.test(row.detail)));
 for(const prefix of ['percent%:', 'under_score_:', '☃:'])assert.deepEqual(workshopValues(sql,prefix),[],'literal prefix absence needs no unrelated migration');
 const failed={exec(){throw Error('Injected SQL reset');}};assert.throws(()=>workshopValues(failed,'agent:'),/Injected SQL reset/,'unexpected storage errors still propagate');
 addWorkshopFact(sql,'agent:new',{agent_id:'new'});
 assert.throws(()=>workshopValues(sql,'agent:'),error=>error.workshop_current_pending&&Number.isFinite(error.retry_at),'a real prefix still refuses partial migration');
 for(let n=0;;n++){try{assert.deepEqual(workshopValues(sql,'agent:'),[{agent_id:'new'}]);break;}catch(error){assert.ok(error.workshop_current_pending);assert.ok(n<10);}}
 forgetWorkshopFacts(sql,{prefix:'agent:'});assert.deepEqual(workshopValues(sql,'agent:'),[]);
 assert.throws(()=>workshopValues(sql,'task:'),/Workshop runs/,'empty-prefix shortcut cannot bypass task owner refusal');
 assert.throws(()=>workshopValues(sql,'unknown:',{newest:1}),/not a kind/,'invalid option semantics are still refused');
});
