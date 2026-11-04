// Native assembly of the canonical Network HTTP behavior. Domain commands and
// peer releases are supplied as admitted native capabilities, never PersonStore
// identities or a general Network dispatch masquerading as independent work.
import {handleNetworkRequest} from '../../list-the-person-for-others-to-find-ask-the-network/src/person-network.mjs';
const fail=(message,status=403)=>Object.assign(new Error(message),{status});
export function nativeNetworkOwner({owner,relay,network,profile,pursuits,stays,current,context,embed,
 releaseContact,publicProfile,aiPings,checkFirstMatches,origin='https://app.gettrillion.ai'}={}){
 if(!owner||typeof relay!=='function'||!network||!profile||!pursuits||!stays||typeof current!=='function'||typeof context!=='function')
  throw new TypeError('Native Network requires its actual account, admitted domain owners, profile, pursuits and current command.');
 const principal=()=>{const actor=context(),value=relay();if(!value||actor?.owner!==owner||!actor.permit_id||!actor.claims?.sign_in)throw fail('The Network request has no current admitted account principal.');return value;};
 const peer=capability=>input=>{if(typeof capability!=='function')throw fail('The current native peer Network capability is unavailable.',503);return capability(input,context());};
 const admittedNetwork=new Proxy(network,{get(target,operation){if(operation==='then')return undefined;const method=Reflect.get(target,operation);return (...args)=>{if(typeof method!=='function')throw fail(`The native Network ${String(operation)} owner is unavailable.`,503);return Reflect.apply(method,target,args);};}});
 const host={nativeNetwork:true,ctx:{id:{toString:()=>owner}},relay,network:()=>admittedNetwork,staysOwner:stays,
  // A listing written may have new first matches: the person's computer checks them after (src/first-match-check.mjs).
  profile:()=>profile.profile(),setProfile:async input=>{const answer=await profile.setProfile(input);checkFirstMatches?.();return answer;},
  fillNetworkProfile:async()=>{const answer=await profile.fillNetworkProfile();checkFirstMatches?.();return answer;},
  embed:(text,purpose)=>{if(typeof embed!=='function')throw fail('The native meaning capability is unavailable.',503);return embed(text,purpose);},
  onYourPath:()=>pursuits.onYourPath(),forgetRooms:()=>pursuits.forgetRooms(),pursuitOfRoom:id=>pursuits.pursuitOfRoom(id),ownPursuit:id=>pursuits.ownPursuit(id),leavePursuit:id=>pursuits.leavePursuit(id),
  releaseNetworkContact:peer(releaseContact),publicNetworkPersonProfile:peer(publicProfile),
  networkAiPings:()=>{if(!aiPings?.read)throw fail('The native Network AI message choices owner is unavailable.',503);return aiPings.read();},
  setNetworkAiPings:input=>{if(!aiPings?.save)throw fail('The native Network AI message choices owner is unavailable.',503);return aiPings.save(input);}};
 return Object.freeze({operations:{'network:request':async input=>{
  await current('network:request',input);const original=principal(),method=input.method??'GET';
  const response=await handleNetworkRequest(host,new Request(new URL(input.path,origin),{method,headers:{'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(input.body??{})})}));
  await current('network:request',input);if(principal()!==original)throw fail('The Network account identity changed.',409);
  const borrowed=method==='GET'&&['/network','/network/person'].includes(new URL(input.path,origin).pathname);
  return {native_response:true,...(borrowed?{native_nonretaining:true}:{}),status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()};
 }}});
}
