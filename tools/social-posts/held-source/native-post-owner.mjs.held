// The canonical social-post lifecycle installed over resource-local EEAF,
// current connection/vault/Namespace supplies and the existing schedule owner.
import { makeSocialPosts, handlePostsRequest, publishThroughTool, voiceThroughTools } from './social-posts.mjs';
import settings from './social-posts.json' with { type:'json' };
import places from '../records/post-place-records.json' with {type:'json'};
import { dataRows } from './data-rows.mjs';
import {loadPostPlaces} from './post-places.mjs';
import {TYPED_ON_SIGNED_IN_SCREEN,pressedOnSignedInPage} from './typed-on-signed-in-screen.mjs';
const jsonEnvelope=async response=>({native_response:true,status:response.status,headers:{'content-type':response.headers.get('content-type')??'application/json'},body:await response.json()});
export function nativePostOwner({env,records,connections,plainFields,heldValue,connectLink,files,later,serviceOrigin,resolveSource,formatOf,send,shop,current,context,now,judge}){
 const voice=voiceThroughTools(shop,settings.voice_tools,{newId:()=>context().request_key});
 const posts=makeSocialPosts({eeaf:records,settings,places:dataRows('post-place',places),placeSource:()=>loadPostPlaces(env,{current:()=>current(context().operation,{},true)}),
  publishing:async()=>{const {postPublishers,postSdk}=await import('./post-publishers.mjs');return {publishers:postPublishers,sdk:postSdk};},
  connections,plainFields,heldValue,connectLink,files,later,serviceOrigin,resolveSource,formatOf,send,now,judge,keepEdit:voice.keepEdit});
 const publish=publishThroughTool(shop,settings.publish_tool_id,{newId:()=>context().request_key});
 const operations={
  'posts:request':async input=>{await current('posts:request',input);const method=input.method??'GET';
   const response=await handlePostsRequest(posts,new Request(new URL(input.path,serviceOrigin()),{method,
    headers:{'content-type':'application/json','x-trillion-app':context().recorder.app??'',...(pressedOnSignedInPage(context().claims)?{[TYPED_ON_SIGNED_IN_SCREEN]:'yes'}:{})},
    ...(method==='GET'?{}:{body:JSON.stringify(input.body??{})})}),{publish,voice:voice.routes});return jsonEnvelope(response);},
  'posts:publish':async input=>{await current('posts:publish',input);const result=await posts.publish(input);await current('posts:publish',input);return result;},
  'posts:check':async input=>{await current('posts:check',input);return posts.check(input);},
  'posts:calendar':async input=>{await current('posts:calendar',input);return posts.calendar(input);},
 };
 return {posts,operations};
}
