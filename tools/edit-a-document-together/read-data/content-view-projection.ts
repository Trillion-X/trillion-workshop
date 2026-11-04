import { readDocumentIndex, type DocumentIndexEntry } from './document-index';

export type ContentViewProjectionRequest = {
  schema: 'documents.content-view-projection.request';
  feed_address: 'package::documents::ca-document-index-feed';
  label?: string;
};

export type ContentViewProjectionReply = {
  schema: 'documents.content-view-projection.reply';
  feed_address: 'package::documents::ca-document-index-feed';
  rows: Array<{ address: string; payload: { kind: 'documents.content-view-row'; id: string; fields: DocumentIndexEntry } }>;
};

// Converts the generic index feed to the record shape owned by Visual Database.
// It filters only on caller-supplied DATA labels and never materializes body data.
export function projectDocumentContentView(
  request: ContentViewProjectionRequest,
  feed: unknown,
): ContentViewProjectionReply {
  const label = typeof request.label === 'string' && request.label.trim() ? request.label.trim() : null;
  const entries = readDocumentIndex(feed).filter((entry) => !label || entry.content_labels.includes(label));
  return {
    schema: 'documents.content-view-projection.reply',
    feed_address: 'package::documents::ca-document-index-feed',
    rows: entries.map((entry) => contentViewRow(entry)),
  };
}

function contentViewRow(entry: DocumentIndexEntry) {
  return {
    address: `package::documents::content-view-row::${entry.doc_id}`,
    payload: {
      kind: 'documents.content-view-row' as const,
      id: entry.doc_id,
      fields: entry,
    },
  };
}
