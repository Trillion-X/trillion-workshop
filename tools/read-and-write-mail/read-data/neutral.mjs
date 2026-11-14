// tools/read-and-write-mail/read-data/neutral.mjs
//
// Purpose: the one shape every mail tool answers a message in, whatever provider the mailbox is on, and the few facts
// about words every adapter shares. A screen, a workflow or an AI reads this row and never a provider's own payload.
//
// Non-Negotiable Invariants:
// 1. Every neutral message carries every field below; a field a read did not ask for is empty ('' , [], null, false),
//    never missing, so a reader never has to know which provider answered or which read it was.
// 2. Labels are the neutral names of mail-providers.json `neutral_labels` where the provider row maps them; a provider's
//    own label that has no neutral name is passed on unchanged.
// 3. Nothing here names a provider; the wire formats are in adapters/<adapter>.mjs.

/** The headers a neutral message names, by neutral field, and the header each is read from. */
export const HEADER_FIELDS = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  bcc: 'bcc',
  reply_to: 'reply-to',
  subject: 'subject',
  date: 'date',
  message_id: 'message-id',
  references: 'references',
  in_reply_to: 'in-reply-to',
  list_unsubscribe: 'list-unsubscribe',
};

/** One neutral message. `headers` is by neutral field (HEADER_FIELDS keys), each a text. */
export function neutralMessage({ id, thread_id = null, draft_id = null, labels = [], date_ms = null, snippet = '', headers = {}, has_calendar_invite = false, text = null, links = [], attachments = [], needs_original = false }) {
  return {
    id,
    thread_id: thread_id || null,
    draft_id: draft_id || null,
    labels,
    date_ms: Number.isFinite(date_ms) ? date_ms : null,
    snippet: snippet || '',
    headers: Object.fromEntries(Object.keys(HEADER_FIELDS).map(field => [field, typeof headers[field] === 'string' ? headers[field] : ''])),
    has_calendar_invite: Boolean(has_calendar_invite),
    text: typeof text === 'string' && text ? text : null,
    links,
    attachments,
    needs_original: Boolean(needs_original),
  };
}

/** The neutral names of a provider's labels (its own, when it has no neutral name for one). */
export const neutralLabels = (provider, wire = []) => (Array.isArray(wire) ? wire : []).map(label => provider.labels?.[label] ?? label);

/** A provider's labels for neutral ones asked for (a name that is not one of its neutral names is its own label). */
export function wireLabels(provider, names = []) {
  const back = Object.fromEntries(Object.entries(provider.labels ?? {}).map(([wire, neutral]) => [neutral, wire]));
  return (Array.isArray(names) ? names : []).map(name => back[name] ?? name);
}
