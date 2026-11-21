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

const MOST_LINKS = 50;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The http and https addresses in a text, each once, at most MOST_LINKS. */
export function linksIn(text) {
  const found = [...String(text ?? '').matchAll(/https?:\/\/[^\s<>"]+/g)].map(match => match[0].replace(/[)\].,;:!?'"]+$/, ''));
  return [...new Set(found)].filter(link => {
    try { return ['http:', 'https:'].includes(new URL(link).protocol); } catch { return false; }
  }).slice(0, MOST_LINKS);
}

/** An HTML body as plain text: scripts and styles dropped, line breaks kept at breaks and block ends, tags removed,
 *  entities decoded. Used only where a message has no plain-text part. */
export function htmlToText(html) {
  const text = String(html ?? '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
      if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    });
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
