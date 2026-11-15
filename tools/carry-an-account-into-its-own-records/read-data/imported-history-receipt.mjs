// The receipt of an imported account's record history (slice E): the EEAF head and erasure substitutions read from the verified
// export's history rows, and every kept history archive the account owns, named by its key and its BLAKE3 identity. It is the
// inherited proof an imported account presents in place of a live carry (src/namespace-native-carry.mjs inherited): the
// archives stay where they are and are referenced, never copied. Its identity binds the export manifests it was read from.
import { makeHashCodeHexFromJson, makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
// The old typed-operation identity canonicalized missing property values as null.
// Preserve that receipt spelling while using the current pure content identity owner.
const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]))
  : typeof value === 'number' && !Number.isFinite(value) ? null : value ?? null;
const receiptIdentity = value => makeHashCodeHexFromJson(normalized(value)).slice(3);
export function createImportedHistoryReceipts({ identityOf = receiptIdentity, historyIdentity = makeHashCodeHexFromBytes } = {}) {

const IMPORTED_HISTORY_RECEIPT = 'trillion.imported-history-receipt/v1';
const refuse = (code, message) => Object.assign(new Error(message), { status: 409, code });

/** head: the export's history_chain head (or null for a book with no history); substitutions: the export's history_substitutions
 * rows; archives: [{ key, first_id, bytes }] listed from the retiring store's history prefix; manifests: the export manifest
 * identities the rows came from; run: the import run id. */
function importedHistoryReceipt({ run, head, substitutions = [], archives = [], manifests = [] }) {
  if (typeof run !== 'string' || !run) throw refuse('imported_history_run', 'An imported history receipt names its import run.');
  const body = { schema: IMPORTED_HISTORY_RECEIPT, run, head: head ?? null,
    substitutions: substitutions.map(({ file, old_identity, new_identity, at }) => ({ file, old_identity, new_identity, at })),
    archives: archives.map(({ key, first_id, bytes, identity }) => ({ key, first_id, bytes, identity })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    manifests: [...manifests].sort() };
  return { ...body, identity: identityOf(body) };
}

/** The archive keys a receipt references, for erasure. */
const receiptArchiveKeys = receipt => receipt.archives.map(archive => archive.key);

/** Re-read each referenced archive object: its size and BLAKE3 identity must match what the receipt recorded. */
async function verifyImportedHistoryReceipt(receipt, bucket) {
  if (receipt?.schema !== IMPORTED_HISTORY_RECEIPT) return false;
  const { identity, ...body } = receipt;
  if (identityOf(body) !== identity) return false;
  for (const archive of receipt.archives) {
    const object = await bucket.get(archive.key);
    if (!object) return false;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== archive.bytes || historyIdentity(bytes) !== archive.identity) return false;
  }
  return true;
}

return { IMPORTED_HISTORY_RECEIPT, importedHistoryReceipt, receiptArchiveKeys, verifyImportedHistoryReceipt };
}
