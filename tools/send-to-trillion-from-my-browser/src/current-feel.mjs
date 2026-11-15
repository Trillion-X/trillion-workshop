// Each open extension view owns its selected feedback. The existing account
// transport supplies bearer/session fencing; there is no background copy/alarm.
import {account,signedInAccount,SignInNeeded} from './trillion.mjs';
export function currentExtensionFeel({readAccount=account,readAccountId=signedInAccount,storage=chrome.storage}={}){
 return {rows:null,
  source:async()=>{
   const expected=await readAccountId();if(!expected)throw new SignInNeeded();
   const result=await readAccount('/tours/presentation?part=feel',undefined,expected);
   if(result?.part!=='feel'||!result.rows||!Array.isArray(result.rows.outputs)||!Array.isArray(result.rows.moments)||!result.rows.feels||typeof result.rows.feels!=='object'||Array.isArray(result.rows.feels))throw new TypeError('The current feel rows could not be read.');
   return result.rows;
  },
  subscribe:changed=>{
   const heard=(changes,area)=>{if(area==='local'&&changes.tokens){changed.invalidate();void changed();}};
   storage.onChanged.addListener(heard);
   return()=>storage.onChanged.removeListener(heard);
  },
 };
}
