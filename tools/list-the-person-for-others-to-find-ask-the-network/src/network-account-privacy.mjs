// Account-side Network privacy algorithms shared by native and legacy hosts.
// Storage, current authorization, agent work and shared membership are supplies;
// this module cannot pick an account store or general Network dispatcher.
import {identityOf} from '../../keep-and-wake-ai-sessions-on-this-computer/src/typed-operation-contract.mjs';
const fail=message=>Object.assign(new Error(message),{status:403});
export function networkAccountPrivacy({profile,setting,setSetting,aiWork,pursuits,records,relay,bothMembers,current=async()=>{}}={}){
 if(typeof profile!=='function'||typeof setting!=='function'||typeof setSetting!=='function'
  ||typeof aiWork!=='function'||typeof pursuits!=='function'||!records||typeof relay!=='function'||typeof bothMembers!=='function')
  throw new TypeError('The actual account profile, choices, work, records and shared-membership capability are required.');
 const choice=()=>setting('network_ai_pings')??{audience:'off',agent_ids:[]};
 const publicProfile=async()=>{
  await current('network:publicProfile',{});const before=profile();if(!before.findable)return null;
  const result={};let board;
  if(before.show_ais||before.show_counts)board=await aiWork({summary:true});
  if(before.show_ais){const pings=choice();result.ais=board.agents.map(agent=>({agent_id:agent.agent_id,name:agent.name,app:agent.app,model:agent.model,
   pingable:pings.audience==='anyone'&&pings.agent_ids.includes(agent.agent_id)&&agent.takes_work}));}
  if(before.show_counts){const decisions=records.count('decision'),ownPursuits=records.count('pursuit');
   if(decisions!==null&&ownPursuits!==null)result.counts={decisions,pursuits:ownPursuits,work_finished:board.agents.reduce((count,agent)=>count+agent.finished,0)};}
  if(before.show_pursuits)result.pursuits=(await pursuits()).slice(0,20).map(item=>({title:item.title,after:item.after}));
  await current('network:publicProfile',{});
  // Opt-outs or narrowing while an asynchronous owner is read cannot release
  // the stale wider view. Callers can retry under the current exact choices.
  if(identityOf(profile())!==identityOf(before))throw fail('The current Network profile choices changed during this read.');
  return result;
 };
 const saveChoice=async(input={})=>{
  await current('network:aiPings',input);const audience=input.audience==='anyone'?'anyone':'off',board=await aiWork({summary:true});
  const available=new Set(board.agents.filter(agent=>agent.takes_work).map(agent=>agent.agent_id)),agent_ids=[...new Set((Array.isArray(input.agent_ids)?input.agent_ids:[]).map(String))];
  if(agent_ids.some(id=>!available.has(id)))throw new Error('Choose an AI connected to this account.');
  await current('network:aiPings',input);const saved={audience,agent_ids};await setSetting('network_ai_pings',saved);return saved;
 };
 const contact=async({membership_id,asking_relay})=>{
  await current('network:contact',{membership_id,asking_relay});const ownRelay=relay(),before=profile().contact;
  if(!before||!await bothMembers(membership_id,asking_relay,ownRelay))return null;
  await current('network:contact',{membership_id,asking_relay});
  if(relay()!==ownRelay||profile().contact!==before)return null;
  // A remote membership read may await; verify current membership again before
  // release rather than reuse a stale first answer across another async check.
  if(!await bothMembers(membership_id,asking_relay,ownRelay))return null;
  if(relay()!==ownRelay||profile().contact!==before)return null;
  return before;
 };
 return Object.freeze({publicProfile,contact,aiPings:{read:choice,save:saveChoice}});
}
