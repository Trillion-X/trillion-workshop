// Ported from old trillion test/cap-change.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. Six tests are the old ones over src/cap-change.mjs here. Nine drove a cap change through old
// src/native-resource-spend.mjs NativeResourceSpend setSpendBudget (the spend owner, with old src/spend-meter.mjs
// spendBudgetRow); neither runs anywhere (searched NativeResourceSpend, setSpendBudget, spendBudgetRow in trillion-workshop
// tools/, trillion-rust src/, trillion-apps web/), so they are left out. The check that a confirmation asks the authenticator
// to verify the person read old src/passkey-options.mjs confirmOptions; the engine's passkeys own that now and trillion-rust
// src/account/sign_in/passkeys.rs options_name_the_relying_party_and_exclude_existing_passkeys checks userVerification
// "required", so it is left out here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {allowCapChange,allowPaidCeilingChange,ceilingOf,confirmationBy,holdCapConfirmation,keepCeiling,takeCapConfirmation} from '../src/cap-change.mjs';
import capData from '../../shared-code/src/cap-change.json' with {type:'json'};
import spendData from '../../shared-code/src/spend-meter.json' with {type:'json'};
import useData from '../../shared-code/src/metered-use.json' with {type:'json'};

const ai={sign_in:'key:agent'}, page={sign_in:'session:page'};
const needsPasskey=/needs a passkey you already had/;

// A pool that keeps challenges the way the Worker's does: taken once.
const fakePool=()=>{const held=new Map();return {held,holdPasskeyChallenge:async(id,record)=>{held.set(id,record);},takePasskeyChallenge:async id=>{const record=held.get(id)??null;held.delete(id);return record;}};};
const paidAs=async(current,dollars,from,now)=>(await allowPaidCeilingChange({current,next:dollars,now,confirm:async()=>(from===null?null:{passkey:`p-${from}`,known_from:from})})).kept;
const paidKept=text=>JSON.parse(text);
const HOUR=3_600_000,DAY=24*HOUR,T0=Date.parse('2026-11-01T00:00:00Z'),SENIOR=T0-90*DAY,JUNIOR=T0-DAY;

test('a deceived lowering of the paid ceiling is restored at once by a passkey as senior as the one that lowered it',async()=>{
 const inForce=JSON.stringify({dollars:2000});
 const lowered=await paidAs(inForce,0,SENIOR,T0);
 assert.equal(paidKept(lowered).dollars,0,'a lowering applies at once');
 assert.equal(paidKept(lowered).restore.to,2000,'it keeps what it lowered from');
 const back=paidKept(await paidAs(lowered,2000,SENIOR,T0+HOUR));
 assert.deepEqual([back.dollars,back.raise,back.restore],[2000,undefined,undefined],'the restore is immediate, no step, no wait');
 // A passkey known later than the one that lowered it restores nothing: past one step it is refused, within one it waits.
 await assert.rejects(paidAs(lowered,2000,JUNIOR,T0+HOUR),/at most|step/i);
 const junior=paidKept(await paidAs(lowered,1000,JUNIOR,T0+HOUR));
 assert.deepEqual([junior.dollars,junior.raise.to],[0,1000]);
 // A later lowering by a junior passkey never loosens who may restore: the most senior lowering decides.
 const twice=await paidAs(JSON.stringify({dollars:2000}),1500,SENIOR,T0);
 const again=await paidAs(twice,0,JUNIOR,T0+HOUR);
 assert.equal(paidKept(again).restore.senior_from,SENIOR);
 await assert.rejects(paidAs(again,2000,JUNIOR,T0+2*HOUR),/at most|step/i);
 assert.equal(paidKept(await paidAs(again,2000,SENIOR,T0+2*HOUR)).dollars,2000);
 // Past the paid window the lowered value is the ceiling: a rise is a raise again.
 const late=paidKept(await paidAs(lowered,1000,SENIOR,T0+31*DAY));
 assert.deepEqual([late.dollars,late.raise.to],[0,1000]);
});

test('a raise never in force is not restored at once: a lowering that ended it brings it back with its own notice time',async()=>{
 const waitingRaise=paidKept(await paidAs(null,2000,SENIOR,T0)).raise;
 assert.ok(Date.parse(waitingRaise.from)>T0,'one step up waits out the notice');
 const lowered=await paidAs(JSON.stringify({dollars:null,raise:waitingRaise}),0,SENIOR,T0+HOUR);
 const back=paidKept(await paidAs(lowered,2000,SENIOR,T0+2*HOUR));
 assert.equal(back.dollars,1000,'the ceiling in force before the lowering returns at once');
 assert.deepEqual(back.raise,waitingRaise,'the ended raise returns with its first notice time, never sooner');
});

test('a confirmation names the passkey that made it, so a restore can weigh its seniority',async()=>{
 const pool=fakePool();
 const id=await holdCapConfirmation(pool,'session:page',{action:'paid-ceiling',dollars:5},'ana',{passkey:'k1',known_from:SENIOR});
 assert.deepEqual(await confirmationBy(pool,id,'session:page',{action:'paid-ceiling',dollars:5}),{passkey:'k1',known_from:SENIOR});
 assert.equal(await confirmationBy(pool,id,'session:page',{action:'paid-ceiling',dollars:5}),null,'used once');
});

test('use budgets follow the same ceiling rule',async()=>{
 const use=(most,extra={})=>({id:'calls-cap',label:'Calls',scope:'person',when:null,per:'purpose',measure:'calls',most,alert_at:0.5,stop:true,period:'day',...extra});
 const pool=fakePool();
 const change=async(previous,next,claims=ai,confirmation)=>{const kept=keepCeiling('use',previous,next);await allowCapChange({family:'use',previous,next:kept,confirm:change=>takeCapConfirmation(pool,confirmation,claims.sign_in,change)});return kept;};
 const day=capData.families.use.ceilings.calls.day, step=capData.most_steps.use.calls.day;
 await change(use(10),use(day));
 await change(null,use(5));
 await change(use(10,{stop:false}),use(10,{stop:true}));
 await assert.rejects(change(use(10),use(day+1)),/most a use limit can be set to is 50000000 calls a day/);
 await assert.rejects(change(use(10),use(10,{stop:false})),needsPasskey);
 await assert.rejects(change(use(10),use(10,{measure:'rows_read'})),needsPasskey);
 await assert.rejects(change(use(10),use(10,{per:'all'})),needsPasskey);
 await assert.rejects(change(use(10),use(10,{ai_ceiling:day+step})),needsPasskey);
 await assert.rejects(change(use(10),use(10,{ai_ceiling:day+step+1}),page),/at most 50000000 calls above/);
 const refused=await change(use(10),use(10,{ai_ceiling:day+step})).catch(error=>error);
 const id=await holdCapConfirmation(pool,page.sign_in,refused.change);
 const raised=await change(use(10),use(10,{ai_ceiling:day+step}),page,id);
 assert.deepEqual([raised.ai_ceiling,raised.ceiling_raise.to],[undefined,day+step],'the raise waits');
 await assert.rejects(change(raised,use(day+1)),/most this limit can be set to now is 50000000/);
 const later=Date.now()+73*3_600_000;
 assert.equal(ceilingOf('use',raised,later),day+step,'from the end of its notice the raise is the ceiling');
 assert.equal(ceilingOf('use',use(1,{ai_ceiling:day*20})),capData.maxima.use.calls.day,'never above the maximum');
});

test('the starting rows are within their own ceilings, so no starting cap is cut by the ceiling',()=>{
 for(const starting of spendData.budgets.filter(r=>r.scope==='person'))assert.ok(starting.most_dollars<=ceilingOf('spend',starting),starting.id);
 for(const starting of useData.budgets.filter(r=>r.scope==='person'))assert.ok(starting.most<=ceilingOf('use',starting),starting.id);
 for(const starting of useData.budgets.filter(r=>r.scope==='person'))assert.ok(capData.families.use.ceilings[starting.measure]?.[starting.period??'day']>0,`${starting.id} has a default ceiling`);
});

test('a passkey confirmation is held for one sign-in and one exact change, once, and asks the authenticator to verify the person',async()=>{
 const change={action:'billing-month',cycle_day:9};
 const pool=fakePool(),id=await holdCapConfirmation(pool,'session:a',change);
 assert.equal(await takeCapConfirmation(pool,id,'session:b',change),false,'taking it for another sign-in uses it up');
 assert.equal(await takeCapConfirmation(pool,id,'session:a',change),false);
 const other=await holdCapConfirmation(pool,'session:a',change);
 assert.equal(await takeCapConfirmation(pool,other,'session:a',{action:'billing-month',cycle_day:10}),false,'it confirms only the change it was made for');
 const again=await holdCapConfirmation(pool,'session:a',{cycle_day:9,action:'billing-month'});
 assert.equal(await takeCapConfirmation(pool,again,'session:a',change),true,'whatever the key order');
 assert.equal(await takeCapConfirmation(pool,again,'session:a',change),false);
 assert.equal(await takeCapConfirmation(pool,undefined,'session:a',change),false);
});
