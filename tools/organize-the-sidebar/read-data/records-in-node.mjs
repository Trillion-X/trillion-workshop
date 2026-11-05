// tools/organize-the-sidebar/read-data/records-in-node.mjs
//
// PURPOSE
//   What `#workspace-records` is when this folder's code runs in Node (package.json `imports`, condition `node`), the
//   way tools/tours-screen/read-data/rows-write-through-keep.mjs is for that tool. On the page it is the workspace's
//   label-addressed records (the host's src/workspace/records.ts). Node has no page, so:
//   - the pure request builders and reply decoders are here, the same shapes the host's records.ts builds, so a writer
//     given its own sender (`writeFocusViewLive(view, partition, sender)`) builds the request the page would send;
//   - every reader, hook and sender that needs the page throws, saying so; a caller passes its own sender instead.
//
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export { makeHashCodeHexFromBytes };

const LABEL_ADDRESSED = 'engine.operation.label-addressed';
const READ_CURRENT = 'engine.operation.read-current';
const WRITE_BATCH = 'engine.operation.write-batch';

const encode = value => new TextEncoder().encode(JSON.stringify(value));

/** A read of one record by its label, answered by the label-addressed read. */
export function buildEngineReadCurrentRequestFromLabels(_partition, addressLabel, _options) {
  return { target: LABEL_ADDRESSED, payload: { operation_label: READ_CURRENT, address_label: addressLabel } };
}

/** The reply of that read: whether the record is there, its bytes as JSON text, and their content identity. */
export function decodeEngineReadCurrentReply(bytes) {
  const reply = JSON.parse(new TextDecoder().decode(bytes));
  if (!reply.found) return { found: false, payload: new Uint8Array(), contentHash: null };
  const payload = encode(reply.payload);
  return { found: true, payload, contentHash: makeHashCodeHexFromBytes(payload) };
}

/** A multihash (unsigned-varint code, unsigned-varint length, digest) as the `<code hex>:<digest hex>` identity. */
function identityOfMultihash(bytes) {
  let at = 0;
  const varint = () => {
    let value = 0, shift = 0, byte = 0;
    do { byte = bytes[at++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return value;
  };
  const code = varint();
  const length = varint();
  return `${code.toString(16)}:${bytesToHex(bytes.subarray(at, at + length))}`;
}

/** A write request built from label entries; a payload given as bytes is its JSON text. */
export function buildEngineWriteBatchRequestFromLabels(entries, options = {}) {
  return {
    target: LABEL_ADDRESSED,
    payload: {
      operation_label: WRITE_BATCH,
      ...(options.conflictPolicy ? { conflict_policy: options.conflictPolicy } : {}),
      writes: entries.map(entry => ({
        address_label: entry.addressLabel ?? entry.addressMultihashHex,
        payload: entry.payloadBytes ? JSON.parse(new TextDecoder().decode(entry.payloadBytes)) : entry.payload ?? entry.value,
        ...(entry.pathLabels ? { path: [...entry.pathLabels] } : {}),
        ...(entry.expectedCurrent ? { expected_identity: entry.expectedCurrent.payloadHash ? identityOfMultihash(entry.expectedCurrent.payloadHash) : null } : {}),
        ...(entry.expectedIdentity !== undefined ? { expected_identity: entry.expectedIdentity } : {}),
      })),
    },
  };
}

const noPage = name => () => {
  throw new Error(`${name} needs the page's workspace records (src/workspace/records.ts); in Node, pass the call its own sender or records.`);
};
export const answerTarget = noPage('answerTarget');
export const createTrustedRuntimeIdMinter = noPage('createTrustedRuntimeIdMinter');
export const decodeWorkflowRunReply = noPage('decodeWorkflowRunReply');
export const placeOf = noPage('placeOf');
export const placedLabel = noPage('placedLabel');
export const readInputValue = noPage('readInputValue');
export const readTrustedRuntimePartitionIfPresent = noPage('readTrustedRuntimePartitionIfPresent');
export const sendRequestToBitfieldTarget = noPage('sendRequestToBitfieldTarget');
export const showRecords = noPage('showRecords');
export const subscribeSavedChanges = noPage('subscribeSavedChanges');
export const useBitfieldData = noPage('useBitfieldData');
export const writeInputValue = noPage('writeInputValue');
