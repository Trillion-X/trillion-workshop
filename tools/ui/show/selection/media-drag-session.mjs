// HTML dragover protects DataTransfer contents. Keep the in-page drag payload
// in one shared document slot so separately bundled source/target views agree.
const key=Symbol.for('shared-ui.media-drag');
export function beginMediaDrag(transfer,type,value){
 const data=JSON.stringify(value);transfer.setData(type,data);transfer.effectAllowed='copy';
 document[key]={type,data};
 document.addEventListener('dragend',()=>{delete document[key];},{once:true});
}
export function readMediaDrag(transfer,type){
 if(!type||!Array.from(transfer.types||[]).includes(type))return null;
 return transfer.getData(type)||(document[key]?.type===type?document[key].data:null);
}
