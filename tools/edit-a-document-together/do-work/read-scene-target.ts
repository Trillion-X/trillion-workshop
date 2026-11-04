import {
  createCompositionDocumentsLogStore,
} from './write-composition-documents';
import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '#workspace-records';
import {
  documentsSceneRef,
  documentsSceneAddressMode,
  type DocumentsSceneTargetDependencies,
} from './scene-target-runtime';
import { buildEngineReadCurrentRequestFromLabels, decodeEngineReadCurrentReply, makeHashCodeHexFromBytes } from '#workspace-records';
import { buildImportedDocument, verifyImportedDocument } from './imported-document.mjs';

export type DocumentsSceneReadRequest = {
  document_ref?: string;
  scene_address_mode?: 'label_hash' | 'identity_text';
  expected_import?: Record<string, unknown>;
};

/** Authoritative Documents readback; the action guard binds the exact owner-local address. */
export async function readDocumentsScene(
  input: DocumentsSceneReadRequest,
  context?: BitfieldRuntimeContext,
  dependencies: DocumentsSceneTargetDependencies = {},
  sender: typeof sendRequestToBitfieldTarget = sendRequestToBitfieldTarget,
) {
  const partitionLabel = readTrustedRuntimePartition(context);
  const addressMode = documentsSceneAddressMode(input.scene_address_mode);
  if (input.expected_import !== undefined) {
    if (input.scene_address_mode === 'label_hash') throw new Error('Imported documents require identity_text addressing.');
    const expected = buildImportedDocument(input.expected_import);
    const documentRef = documentsSceneRef(input.document_ref ?? (expected.ok ? expected.document_record.address : undefined));
    if (!expected.ok || expected.document_record.address !== documentRef) {
      throw new Error('The requested draft belongs to a different document.');
    }
    const addresses = [expected.document_record.address, expected.index_record.address];
    const readRows = async () => Promise.all(addresses.map(async address => {
      const reply = await sender(buildEngineReadCurrentRequestFromLabels(partitionLabel, address, {addressMode:'identity-text'}));
      const value = ArrayBuffer.isView(reply) || reply instanceof ArrayBuffer ? reply : (reply as {payload?: unknown})?.payload;
      const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
      if (!bytes) throw new Error('The saved document could not be read.');
      const current = decodeEngineReadCurrentReply(bytes);
      if (!current.found || !current.payload) throw new Error('The saved document is missing.');
      return {address, content_hash: makeHashCodeHexFromBytes(current.payload),
        payload: JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(current.payload))};
    }));
    const first = await readRows();
    const verified = verifyImportedDocument(input.expected_import, first);
    const second = await readRows();
    if (second.some((row, i) => row.content_hash !== first[i].content_hash)) {
      throw new Error('The document changed during the check. Retry with the current draft.');
    }
    return {schema:'documents.scene-read.receipt', status:'verified', ...verified};
  }
  const documentRef = documentsSceneRef(input?.document_ref);
  const createStore: NonNullable<DocumentsSceneTargetDependencies['createStore']> = dependencies.createStore
    ?? ((partition, clock, reference, mode) => createCompositionDocumentsLogStore(partition, clock, reference, undefined, mode));
  const snapshot = await createStore(
    partitionLabel,
    () => readTrustedRuntimeClockMs(context),
    documentRef,
    addressMode,
  ).readSnapshot();
  return {
    schema: 'documents.scene-read.receipt',
    status: snapshot.content ? 'found' : 'missing',
    document_ref: documentRef,
    document_hash: snapshot.documentHash,
    content: snapshot.content,
  } as const;
}
