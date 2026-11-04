import test from 'node:test';
import assert from 'node:assert/strict';
import {networkAccountPrivacy} from '../src/network-account-privacy.mjs';
const fixture=()=>{
 let shown={findable:true,contact:'private contact',show_ais:false,show_counts:false,show_pursuits:false},choices={},membership=true;
 const options={profile:()=>({...shown}),setting:key=>choices[key],setSetting:(key,value)=>{choices[key]=value;},aiWork:async()=>({agents:[{agent_id:'helper',name:'Helper',app:'Codex',model:'chosen',takes_work:true,finished:3}]}),pursuits:async()=>[{title:'A private pursuit',after:'A result'}],records:{count:type=>type==='decision'?4:2},relay:()=> 'owner-relay',bothMembers:async()=>membership};
 return {options,make:()=>networkAccountPrivacy(options),show:input=>{shown={...shown,...input};},leave:()=>{membership=false;}};
};
test('native public Network profile discloses only individually opted-in sections',async()=>{
 const f=fixture(),privacy=f.make();assert.deepEqual(await privacy.publicProfile(),{});
 f.show({show_ais:true,show_counts:true,show_pursuits:true});await privacy.aiPings.save({audience:'anyone',agent_ids:['helper']});
 const result=await privacy.publicProfile();assert.equal(result.ais[0].pingable,true);assert.deepEqual(result.counts,{decisions:4,pursuits:2,work_finished:3});assert.equal(result.pursuits.length,1);assert.equal(result.contact,undefined);
 f.show({findable:false});assert.equal(await privacy.publicProfile(),null);await assert.rejects(privacy.aiPings.save({agent_ids:['foreign-helper']}),/connected to this account/);
});
test('profile opt-out during native pursuits read withholds the older wider view',async()=>{
 const f=fixture();f.show({show_pursuits:true});f.options.pursuits=async()=>{f.show({show_pursuits:false});return [{title:'private'}];};
 await assert.rejects(f.make().publicProfile(),/choices changed/);
});
test('contact release rechecks membership and profile before output',async()=>{
 const f=fixture(),privacy=f.make();assert.equal(await privacy.contact({membership_id:'space',asking_relay:'peer'}),'private contact');f.leave();assert.equal(await privacy.contact({membership_id:'space',asking_relay:'peer'}),null);
 const g=fixture();let reads=0;g.options.bothMembers=async()=>++reads===1;assert.equal(await g.make().contact({membership_id:'space',asking_relay:'peer'}),null);
 const h=fixture();h.options.bothMembers=async()=>{h.show({contact:''});return true;};assert.equal(await h.make().contact({membership_id:'space',asking_relay:'peer'}),null);
});
