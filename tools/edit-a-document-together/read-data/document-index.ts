// packages/documents/read-data/document-index.ts
//
// The document index is a generic, body-free projection. Every editable
// composition document gets one pointer row; its canonical body remains only at
// `doc_address`. Consumers such as Visual Database choose labels and views as DATA.

import { flattenProjectedRows, isRecord } from './documents';

// Per-document scene address: the editable node tree lives here (path
// current-item/published-record, written via action:composition.write-document).
export const DOCUMENT_ADDRESS_PREFIX = 'package::documents::documents::';
export function documentAddressForId(docId: string): string {
  return `${DOCUMENT_ADDRESS_PREFIX}${docId}`;
}
export function docIdFromAddress(address: string): string | null {
  return address.startsWith(DOCUMENT_ADDRESS_PREFIX)
    ? address.slice(DOCUMENT_ADDRESS_PREFIX.length)
    : null;
}

// The index row: address + kind the scoped feed matches on.
export const DOCUMENT_INDEX_ADDRESS_PREFIX = 'package::documents::document-index::';
export const DOCUMENT_INDEX_KIND = 'composition-document-index';

export function documentIndexAddressForId(docId: string): string {
  return `${DOCUMENT_INDEX_ADDRESS_PREFIX}${docId}`;
}

export type DocumentIndexEntry = {
  doc_id: string;
  doc_address: string;
  doc_address_mode?: 'identity_text' | 'label_hash';
  title: string;
  summary: string;
  content_labels: string[];
  content_type: string;
  status: string;
  document_revision_hash: string;
  // Row-carried intent for generic surfaces to open the canonical editor.
  surface_intent: Record<string, unknown>;
  updated_at: string;
};

// Build the `{address, payload}` index record a producer writes alongside the
// document. `updated_at` defaults to now so a re-write bumps the list order.
export type DocumentIndexRecordPayload = DocumentIndexEntry & { kind: typeof DOCUMENT_INDEX_KIND };

export function buildDocumentIndexRecord(entry: {
  docId: string;
  title: string;
  summary?: string;
  contentLabels?: string[];
  contentType?: string;
  status?: string;
  documentRevisionHash?: string;
  addressMode?: 'identity_text' | 'label_hash';
  updatedAt?: string;
}): { address: string; payload: DocumentIndexRecordPayload } {
  const contentLabels = (entry.contentLabels ?? [])
    .filter((label): label is string => typeof label === 'string' && Boolean(label.trim()))
    .map((label) => label.trim());
  const docAddress = documentAddressForId(entry.docId);
  const payload: DocumentIndexRecordPayload = {
    kind: DOCUMENT_INDEX_KIND,
    doc_id: entry.docId,
    doc_address: docAddress,
    doc_address_mode: entry.addressMode ?? 'identity_text',
    title: entry.title.trim() || 'Untitled document',
    summary: (entry.summary ?? '').trim(),
    content_labels: contentLabels,
    content_type: (entry.contentType ?? 'document').trim() || 'document',
    status: (entry.status ?? 'draft').trim(),
    document_revision_hash: (entry.documentRevisionHash ?? '').trim(),
    surface_intent: {
      title: entry.title.trim() || 'Untitled document',
      packageEntry: { packageName: 'documents', entryName: 'documents' },
      surfaceInput: { scene_address: docAddress, scene_address_mode: entry.addressMode ?? 'identity_text', expected_document_revision: (entry.documentRevisionHash ?? '').trim() },
    },
    updated_at: entry.updatedAt ?? new Date().toISOString(),
  };
  return { address: documentIndexAddressForId(entry.docId), payload };
}

// Read the scoped index feed -> a sorted (newest first) list of library entries.
// Blind to which producer wrote a row; a row is an index entry iff its payload is
// `{kind:"composition-document-index", …}` with a doc_id. Rows missing required
// fields are dropped (never a crash). Same by-kind fold as every other registry.
export function readDocumentIndex(raw: unknown): DocumentIndexEntry[] {
  const byId = new Map<string, DocumentIndexEntry>();
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (!isRecord(payload) || payload.kind !== DOCUMENT_INDEX_KIND) continue;
    const docId = typeof payload.doc_id === 'string' ? payload.doc_id : null;
    if (!docId) continue;
    const docAddress = typeof payload.doc_address === 'string' && payload.doc_address
      ? payload.doc_address
      : documentAddressForId(docId);
    const intentInput = isRecord(payload.surface_intent) && isRecord(payload.surface_intent.surfaceInput)
      ? payload.surface_intent.surfaceInput : {};
    const addressMode = payload.doc_address_mode ?? intentInput.scene_address_mode
      ?? (docAddress.startsWith(DOCUMENT_ADDRESS_PREFIX) ? 'identity_text' : 'label_hash');
    if (addressMode !== 'identity_text' && addressMode !== 'label_hash') continue;
    if (intentInput.scene_address_mode !== undefined && intentInput.scene_address_mode !== addressMode) continue;
    const suppliedIntent = isRecord(payload.surface_intent) ? payload.surface_intent : null;
    const isDocumentsIntent = suppliedIntent && isRecord(suppliedIntent.packageEntry)
      && suppliedIntent.packageEntry.packageName === 'documents'
      && suppliedIntent.packageEntry.entryName === 'documents';
    if (isDocumentsIntent && intentInput.scene_address !== undefined && intentInput.scene_address !== docAddress) continue;
    byId.set(docId, {
      doc_id: docId,
      doc_address: docAddress,
      doc_address_mode: addressMode,
      title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Untitled document',
      summary: typeof payload.summary === 'string' ? payload.summary : '',
      content_labels: Array.isArray(payload.content_labels)
        ? payload.content_labels.filter((label): label is string => typeof label === 'string' && Boolean(label.trim())).map((label) => label.trim())
        : [],
      content_type: typeof payload.content_type === 'string' && payload.content_type.trim() ? payload.content_type.trim() : 'document',
      status: typeof payload.status === 'string' ? payload.status : 'draft',
      document_revision_hash: typeof payload.document_revision_hash === 'string' ? payload.document_revision_hash : '',
      surface_intent: suppliedIntent
        ? isDocumentsIntent ? {
            ...suppliedIntent,
            surfaceInput: { ...intentInput, scene_address: docAddress, scene_address_mode: addressMode, expected_document_revision: typeof payload.document_revision_hash === 'string' ? payload.document_revision_hash : '' },
          } : suppliedIntent
        : {
            title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Untitled document',
            packageEntry: { packageName: 'documents', entryName: 'documents' },
            surfaceInput: { scene_address: docAddress, scene_address_mode: addressMode, expected_document_revision: typeof payload.document_revision_hash === 'string' ? payload.document_revision_hash : '' },
          },
      updated_at: typeof payload.updated_at === 'string' ? payload.updated_at : '',
    });
  }
  return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
