// Local checkpoints are private working state, never a rendered or approved result.
// Compare before replacing so another open editor's checkpoint is not overwritten.
export function createEditRecovery({key,baseline,validate=()=>true,storage=localStorage,maxBytes=1000000}){
 const identity=JSON.stringify(baseline);let expected=storage.getItem(key),lastData;
 const read=()=>{if(!expected)return null;let row;try{row=JSON.parse(expected);}catch{throw Error('The previous unfinished edit cannot be read. It has been kept.');}if(row.version!==1||row.baseline!==identity||!validate(row.data))throw Error('The saved video changed since the unfinished edit. The unfinished edit has been kept.');lastData=JSON.stringify(row.data);return structuredClone(row.data);};
 const save=data=>{if(!validate(data))throw Error('The unfinished edit could not be backed up.');const encoded=JSON.stringify(data);if(encoded===lastData)return;if(encoded.length>maxBytes)throw Error('This unfinished edit is too large for local recovery. Save a video version to keep it.');if(storage.getItem(key)!==expected)throw Error('This video has another open edit. Save a version to keep these changes.');const value=JSON.stringify({version:1,baseline:identity,data,updated_at:new Date().toISOString()});storage.setItem(key,value);expected=value;lastData=encoded;};
 const clear=()=>{if(storage.getItem(key)!==expected)return false;storage.removeItem(key);expected=null;lastData=undefined;return true;};
 return {read,save,clear};
}
