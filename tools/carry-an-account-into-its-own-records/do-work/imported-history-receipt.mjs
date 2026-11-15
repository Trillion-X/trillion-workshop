import { createImportedHistoryReceipts } from '../read-data/imported-history-receipt.mjs';
import { readWholeFile } from '../../records-door/read-data/whole-file.mjs';
export async function checkImportedHistoryReceipt(input = {}, { door } = {}) {
 const owner=createImportedHistoryReceipts();
 if(input.operation==='create')return owner.importedHistoryReceipt(input.import);
 if(input.operation==='archive-keys')return {keys:owner.receiptArchiveKeys(input.receipt)};
 if(input.operation!=='verify')throw new Error('Choose create, archive-keys or verify.');
 const bucket={async get(key){
  const file=await readWholeFile(door,key);
  if(!file.bytes)throw new Error('A history archive exceeds the bounded file read; no verification was claimed.');
  return {arrayBuffer:async()=>file.bytes.buffer.slice(file.bytes.byteOffset,file.bytes.byteOffset+file.bytes.byteLength)};
 }};
 return {verified:await owner.verifyImportedHistoryReceipt(input.receipt,bucket)};
}
