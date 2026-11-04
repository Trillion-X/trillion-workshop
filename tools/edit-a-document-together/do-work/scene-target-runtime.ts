import type { CompositionDocumentsLogStore } from './write-composition-documents';

export type DocumentsSceneTargetDependencies = {
  /** `readClockMs` is the runtime's clock, read lazily: a read-only target never calls it. */
  createStore?: (partitionLabel: string, readClockMs: () => number, documentRef: string, addressMode?: 'label-hash' | 'identity-text') => CompositionDocumentsLogStore;
  selectionRevision?: string | null;
};

const DOCUMENTS_SCENE_ADDRESS = 'package::documents::documents';

export function documentsSceneAddressMode(value: unknown): 'label-hash' | 'identity-text' {
  if (value === undefined || value === 'label_hash') return 'label-hash';
  if (value === 'identity_text') return 'identity-text';
  throw new Error('scene_address_mode must be label_hash or identity_text');
}

export function documentsSceneRef(value: unknown): string {
  if (typeof value !== 'string' || (
    value !== DOCUMENTS_SCENE_ADDRESS
    && (!value.startsWith(`${DOCUMENTS_SCENE_ADDRESS}::`) || value.length === DOCUMENTS_SCENE_ADDRESS.length + 2)
  )) {
    throw new Error('document_ref must name a Documents-owned scene address');
  }
  return value;
}
