// Session-only output is a live return, never accounting/recovery content.
// Preserve the exact original result identity and every amount/lease binding.
import {identityOf} from '../../shared-code/src/typed-operation-contract.mjs';
export function retainedNativeTerminal(receipt){
 if(receipt?.native_nonretaining!==true)return receipt;
 const {result,execution,output_error,...kept}=receipt;
 const source=execution?Object.fromEntries(['execution_ref','call_id','operation','capture_kind','origin','phase','captured_at','created_at','updated_at'].filter(key=>execution[key]!==undefined).map(key=>[key,execution[key]])):null;
 if(source){source.recorder={reader:null,app:null,basis:'server',app_basis:'unknown'};source.actor={basis:'unknown'};source.links={};}
 if(kept.withheld)kept.withheld={status:kept.withheld.status};
 const result_identity=receipt.result_identity??(Object.hasOwn(receipt,'result')?identityOf(result):null);
 return {...kept,...(source?{execution:source}:{}),...(result_identity?{result_identity}:{}),result_withheld:true};
}
