// src/sent-tools.mjs
//
// Purpose
//   The MCP tools for a person's Sent (src/sent.mjs): list_sent reads everything their AIs sent out in the world,
//   newest first (the same answer as the Sent screen's GET /work/api/sent), and record_sent keeps one thing an AI sent
//   by a road that did not keep it itself (a Workshop row that maps what it sent keeps its own record).
//
// Non-negotiable invariants
//   1. One owner: both tools reach the person store's /sent routes; nothing here checks or shapes a record.
//   2. The authenticated recorder is distinct from the original sender, which may be unknown on a retrospective import.
//
import SENT_KINDS from '../../keep-and-wake-ai-sessions-on-this-computer/records/sent-kinds.json' with { type: 'json' };

const kinds = SENT_KINDS.kinds.map(row => row.id);

export const sentTools = call => [
  { name: 'list_sent', description: 'Everything this person\'s AIs sent out in the world, newest first: each email, post, comment, direct message, reply or order, with who it went to, its subject or title, the exact words (and the email as it was drawn), when it went, the sending tool and captured originating AI when known, its separate recorder, a short preview and, when there is one, a link that opens it where it went (open, such as "Open in Gmail"). kinds says how each kind reads. limit caps how many (default 50, at most 200). Pass the returned next_page as before to continue. It changes nothing.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 }, before: { type: 'object', required: ['value', 'id'], properties: { value: { type: 'string' }, id: { type: 'string' } }, additionalProperties: false } } }, run: ({ limit, before } = {}) => {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (before) query.set('before', JSON.stringify(before));
    return call(`/sent${query.size ? `?${query}` : ''}`);
  } },
  { name: 'record_sent', description: `Keeps one thing you sent out for this person by a road that did not keep it itself (an email from another app, a post, a comment, a direct message, a reply, an order), so it shows in their Sent with the rest: kind (${kinds.join(', ')}), to (who or where it went: addresses, handles or places), body_markdown (the exact words), and optionally subject (an email's subject or a post's title), sent_at (when it went; now when left out), from, reply_to, provider and provider_id (the service and its own id for it), open_url (where it can be opened), body_html and body_text (the email as it was drawn), and id, task_id and tool_id when it came from a tool run. The same id again replaces it. Returns its id.`, inputSchema: { type: 'object', required: ['kind', 'to', 'body_markdown'], properties: {
    kind: { type: 'string', enum: kinds },
    to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Who or where it went' },
    body_markdown: { type: 'string', description: 'The exact words that were sent' },
    subject: { type: 'string' },
    sent_at: { type: 'string', format: 'date-time' },
    from: { type: 'string' },
    reply_to: { type: 'string' },
    preheader: { type: 'string' },
    provider: { type: 'string', description: 'The service it went through' },
    provider_id: { type: 'string', description: 'That service\'s own id for it' },
    provider_account: { type: 'string', description: 'The provider account observed in source evidence; never guess it from the current recorder' },
    execution_ref: { type: 'string', description: 'A source receipt already captured for the original action, when known' },
    origin: { type: 'string', enum: ['real', 'synthetic', 'unknown'] },
    open_url: { type: 'string', format: 'uri', description: 'Where it can be opened' },
    body_html: { type: 'string' },
    body_text: { type: 'string' },
    id: { type: 'string', description: 'Its id in Sent, such as the task id of the run that sent it; a new one when left out' },
    task_id: { type: 'string', description: 'The tool run that sent it' },
    tool_id: { type: 'string', description: 'The tool that sent it' },
  } }, run: input => call('/sent', input) },
];

export const sentAnnotations = {
  list_sent: { title: 'List what my AIs sent', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  record_sent: { title: 'Record something sent', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
