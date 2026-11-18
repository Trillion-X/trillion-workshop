import { createImportedHistoryReceipts } from '../read-data/imported-history-receipt.mjs';
// archives(key) is handed the bytes of one history archive by its caller (a Uint8Array), or null when it has none to hand.
// The tool reads no store and no door: the caller reads its own files and says what they hold.
export async function checkImportedHistoryReceipt(input = {}, { archives } = {}) {
 const owner=createImportedHistoryReceipts();
 if(input.operation==='create')return owner.importedHistoryReceipt(input.import);
 if(input.operation==='archive-keys')return {keys:owner.receiptArchiveKeys(input.receipt)};
 if(input.operation!=='verify')throw new Error('Choose create, archive-keys or verify.');
 const bucket={async get(key){
  const bytes=await archives?.(key);
  if(!bytes)throw new Error('A history archive is not handed in; no verification was claimed.');
  return {arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
 }};
 return {verified:await owner.verifyImportedHistoryReceipt(input.receipt,bucket)};
}
