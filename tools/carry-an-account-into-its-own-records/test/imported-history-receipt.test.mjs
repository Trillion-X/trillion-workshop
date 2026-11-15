// The imported account's history receipt (src/imported-history-receipt.mjs): its archives are referenced by key and BLAKE3,
// verified by re-reading the objects, and any change to an archive or to the receipt itself is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportedHistoryReceipts } from '../read-data/imported-history-receipt.mjs';
import { makeHashCodeHexFromBytes as historyIdentity } from '../../content-identity/read-data/identity.mjs';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const identityOf = value => historyIdentity(new TextEncoder().encode(canonical(value))).slice(3);
const { importedHistoryReceipt, receiptArchiveKeys, verifyImportedHistoryReceipt } = createImportedHistoryReceipts({ identityOf, historyIdentity });


function bucketOf(objects) {
  return { async get(key) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null; } };
}
const archiveBytes = text => new TextEncoder().encode(text);
const archiveOf = (key, text) => ({ key, first_id: key, bytes: archiveBytes(text).byteLength, identity: historyIdentity(archiveBytes(text)) });

test('a receipt names its archives by key and BLAKE3 and verifies against the objects it names', async () => {
  const objects = new Map([['history/a.jsonl', archiveBytes('{"history_chain":{"previous":null}}\n')], ['history/b.jsonl', archiveBytes('{"x":1}\n')]]);
  const receipt = importedHistoryReceipt({ run: 'run-1', head: 'head-1', substitutions: [], manifests: ['m1', 'm2'],
    archives: [archiveOf('history/a.jsonl', '{"history_chain":{"previous":null}}\n'), archiveOf('history/b.jsonl', '{"x":1}\n')] });
  assert.deepEqual(receiptArchiveKeys(receipt), ['history/a.jsonl', 'history/b.jsonl']);
  assert.equal(await verifyImportedHistoryReceipt(receipt, bucketOf(objects)), true);
  // The same receipt, rebuilt from the same inputs, has the same identity: the receipt is a pure function of the export.
  assert.equal(importedHistoryReceipt({ run: 'run-1', head: 'head-1', substitutions: [], manifests: ['m2', 'm1'],
    archives: [archiveOf('history/b.jsonl', '{"x":1}\n'), archiveOf('history/a.jsonl', '{"history_chain":{"previous":null}}\n')] }).identity, receipt.identity);
});

test('a changed archive object or a changed receipt is refused', async () => {
  const receipt = importedHistoryReceipt({ run: 'run-1', head: 'head-1', archives: [archiveOf('history/a.jsonl', 'kept')] });
  assert.equal(await verifyImportedHistoryReceipt(receipt, bucketOf(new Map([['history/a.jsonl', archiveBytes('altered')]]))), false, 'an altered archive is refused');
  assert.equal(await verifyImportedHistoryReceipt(receipt, bucketOf(new Map())), false, 'a missing archive is refused');
  assert.equal(await verifyImportedHistoryReceipt({ ...receipt, head: 'head-2' }, bucketOf(new Map([['history/a.jsonl', archiveBytes('kept')]]))), false, 'a changed head is refused');
});

test('current pure identity defaults preserve the old receipt spelling, including missing optional archive fields',()=>{
 const defaults=createImportedHistoryReceipts();
 for(const archives of [[],[{key:'one'}],[{key:'one',bytes:NaN}],[archiveOf('history/a','kept')]]){
  const input={run:'same-import',archives};
  assert.deepEqual(defaults.importedHistoryReceipt(input),importedHistoryReceipt(input));
 }
});
