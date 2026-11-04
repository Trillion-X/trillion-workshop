import {
  serializeScene,
  type SceneSerializationFormat,
  type SceneSerializationLimits,
  type SceneSerializationResult,
} from './scene-serializers';
import type { InlineMark } from '../read-data/inline-tokens.ts';
import {
  createCompositionDocumentsLogStore,
} from './write-composition-documents';
import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  type BitfieldRuntimeContext,
} from '#workspace-records';
import {
  documentsSceneRef,
  type DocumentsSceneTargetDependencies,
} from './scene-target-runtime';

export type SerializeDocumentsSceneRequest = {
  document_ref: string;
  format: SceneSerializationFormat;
  limits?: Partial<SceneSerializationLimits>;
  /** Current inline-mark DATA rows from the same registry feed used by the editor. */
  inline_marks?: readonly InlineMark[];
};

export type SerializeDocumentsSceneReceipt = {
  schema: 'documents.scene-serialization.receipt';
  status: 'success' | 'not-found' | 'denied';
  document_ref: string;
  document_hash: string | null;
  result?: SceneSerializationResult;
  reason?: string;
};

/** Read-only Documents owner target: serialize exactly the current guarded owner scene. */
export async function serializeDocumentsScene(
  request: SerializeDocumentsSceneRequest,
  context?: BitfieldRuntimeContext,
  dependencies: DocumentsSceneTargetDependencies = {},
): Promise<SerializeDocumentsSceneReceipt> {
  const partitionLabel = readTrustedRuntimePartition(context);
  let documentRef: string;
  try { documentRef = documentsSceneRef(request?.document_ref); }
  catch { return denied(typeof request?.document_ref === 'string' ? request.document_ref : '', 'untrusted-document-ref'); }
  if (request.format !== 'html' && request.format !== 'jsx') {
    return denied(documentRef, 'invalid-format');
  }
  const createStore = dependencies.createStore ?? createCompositionDocumentsLogStore;
  const snapshot = await createStore(partitionLabel, () => readTrustedRuntimeClockMs(context), documentRef).readSnapshot();
  if (!snapshot.content || !snapshot.documentHash) {
    return {
      schema: 'documents.scene-serialization.receipt',
      status: 'not-found',
      document_ref: documentRef,
      document_hash: snapshot.documentHash,
      reason: 'document-not-found',
    };
  }
  return {
    schema: 'documents.scene-serialization.receipt',
    status: 'success',
    document_ref: documentRef,
    document_hash: snapshot.documentHash,
    result: serializeScene(snapshot.content.children, request.format, { limits: request.limits, inlineMarks: request.inline_marks }),
  };
}

function denied(documentRef: string, reason: string): SerializeDocumentsSceneReceipt {
  return {
    schema: 'documents.scene-serialization.receipt',
    status: 'denied',
    document_ref: documentRef,
    document_hash: null,
    reason,
  };
}
