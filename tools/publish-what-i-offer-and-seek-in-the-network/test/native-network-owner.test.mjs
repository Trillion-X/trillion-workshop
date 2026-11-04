import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeNetworkOwner} from '../src/native-network-owner.mjs';
function fixture(overrides={}){
 const calls=[],actor={owner:'owner',resource:'@own-records',permit_id:'permit',claims:{sign_in:'key:owner'}};
 const options={owner:'owner',relay:()=> 'me',context:()=>actor,current:async()=>{},profile:{profile:()=>({name:'Me'}),fillNetworkProfile:async()=>{},setProfile:async input=>input},
 network:{},pursuits:{forgetRooms:()=>calls.push('forget'),pursuitOfRoom:async id=>({id:`pursuit:${id}`})},stays:{},...overrides};
 const run=input=>nativeNetworkOwner(options).operations['network:request'](input);return {run,calls,actor,options};
}
test('native membership creation fixes actor identity and adopts the created pursuit',async()=>{
 let creation;const f=fixture({network:{createMembership:async input=>{creation=input;return {membership_id:'space'};}}});
 const answer=await f.run({path:'/network/memberships',method:'POST',body:{relay:'attacker',person_ref:'other-owner',label:'group',title:'Our group'}});
 assert.equal(answer.status,200);assert.deepEqual(creation,{relay:'me',person_ref:'owner',label:'group',title:'Our group'});assert.deepEqual(answer.body,{membership_id:'space',pursuit_id:'pursuit:space'});assert.deepEqual(f.calls,['forget']);
});
test('contacts and person detail use the native peer capability with the actual admitted parent',async()=>{
 const peers=[];const f=fixture({network:{remember:async()=>{},inbox:async()=>({memberships:[{membership_id:'space',others:[{relay:'peer',person_ref:'peer-owner'}]}]}),publicPerson:async()=>({relay:'peer',person_ref:'peer-owner',name:'Peer'})},releaseContact:async(input,parent)=>{peers.push({input,parent});return 'private contact';},publicProfile:async()=>({ais:[]})});
 const network=await f.run({path:'/network',method:'GET'});assert.equal(network.body.memberships[0].others[0].contact,'private contact');assert.equal(network.native_nonretaining,true);assert.equal(peers[0].parent,f.actor);assert.equal(peers[0].input.asking_relay,'me');
 const person=await f.run({path:'/network/person?relay=peer'});assert.equal(person.native_nonretaining,true);assert.equal(person.body.person_ref,undefined);assert.equal(person.body.name,'Peer');
});
test('unknown methods do not dispatch and missing capabilities remain unavailable',async()=>{
 const f=fixture();assert.equal((await f.run({path:'/network/find',method:'DELETE'})).status,404);
 await assert.rejects(f.run({path:'/network/find',method:'POST',body:{need:'A friend'}}),/meaning capability/);
 f.actor.owner='someone-else';await assert.rejects(f.run({path:'/network'}),/current admitted account principal/);
});
test('on your path: open spaces close to a pursuit by meaning, people from the Network, and nothing without pursuits',async()=>{
 const {pursuitsOnYourPath}=await import('../../list-the-person-for-others-to-find-ask-the-network/src/person-network.mjs');
 const asked=[];const network={onPath:async input=>{asked.push(input);return [{relay:'peer'}];},
  communities:async caller=>{asked.push(caller);return [{community_id:'close',title:'Coaching',about:'',members:3,may_join:true},{community_id:'far',title:'Clocks',members:2,may_join:true},{community_id:'mine',title:'Coaching too',member:true,may_join:true},{community_id:'closed',title:'Coaching',may_join:false}];}};
 const meanings=async texts=>texts.map(text=>text.startsWith('Coaching')?[1,0]:[0,1]);
 const answer=await pursuitsOnYourPath({mine:[{title:'Grow my coaching',embedding:[1,0]}],network,asker:'me',caller:{relay:'me'},meanings});
 assert.deepEqual(answer,{pursuits:1,people:[{relay:'peer'}],spaces:[{community_id:'close',title:'Coaching',about:'',members:3,similarity:1,yours:'Grow my coaching'}]});
 assert.deepEqual(asked[0],{asker:'me',pursuits:[{title:'Grow my coaching',embedding:[1,0]}]});
 assert.deepEqual(await pursuitsOnYourPath({mine:[],network:{},asker:'me',caller:{},meanings}),{pursuits:0,people:[],spaces:[]});
});
test('writing the listing queues the check of its first matches on the person\'s computer, after the write',async()=>{
 const order=[];const f=fixture({profile:{profile:()=>({}),fillNetworkProfile:async()=>{order.push('filled');return {filled:true};},setProfile:async input=>{order.push('written');return input;}},checkFirstMatches:()=>order.push('check queued')});
 assert.equal((await f.run({path:'/network/profile',method:'PUT',body:{seeking:'investors'}})).status,200);
 assert.equal((await f.run({path:'/network/ensure-profile',method:'POST'})).status,200);
 assert.deepEqual(order,['written','check queued','filled','check queued']);
 const without=fixture();assert.equal((await without.run({path:'/network/profile',method:'PUT',body:{}})).status,200,'an owner without the check still writes');
});
