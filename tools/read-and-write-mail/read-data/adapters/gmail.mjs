// tools/read-and-write-mail/read-data/adapters/gmail.mjs
//
// Purpose: Gmail's wire format and nothing else: each neutral mail operation as the Gmail API requests it
// (https://gmail.googleapis.com/gmail/v1/users/me, the requests of the earlier tool:google-account-* rows, request for
// request), and Gmail's replies (MIME payload parts, labelIds, sendAs) as the neutral message rows of ../neutral.mjs.
// It is kept as code because a wire format is Physics: MIME decoding and composing, base64url, RFC 2822 headers and
// header folding are rules of the format, not choices of ours. It is reached only through its row in
// ../mail-providers.json (adapter: "gmail").
//
// Non-Negotiable Invariants:
// 1. Only a decoded text/plain part is handed on as the message's text; an HTML part is read only for its link
//    addresses, and is never handed on.
// 2. A composed message carries no header line break the person typed (header injection), writes non-ASCII headers as
//    UTF-8 encoded words, and keeps reply references.
// 3. A draft that carries anything a plain-text edit would lose (an attachment, a non-text part, an inline part, a Bcc
//    line) says needs_original, so no screen saves over it.

import { HEADER_FIELDS, neutralLabels, neutralMessage, wireLabels } from '../neutral.mjs';

const MOST_LINKS = 50;
const enc = encodeURIComponent;

const headerOf = (payload, name) => {
  const wanted = name.toLowerCase();
  return payload?.headers?.find(header => header.name?.toLowerCase() === wanted)?.value?.trim() ?? '';
};

/** Gmail base64url to text (UTF-8), or null when it is not readable. */
export function decodeBase64Url(value) {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return new TextDecoder('utf-8').decode(Uint8Array.from(atob(normalized), character => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The first decoded text/plain part. HTML is never returned. */
export function plainTextBody(payload) {
  if (!payload) return null;
  const candidates = [];
  const visit = part => {
    if (part.mimeType?.toLowerCase() === 'text/plain') {
      const decoded = decodeBase64Url(part.body?.data);
      if (decoded?.trim()) candidates.push(decoded.trim());
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return candidates[0] ?? null;
}

/** The web links in a message's text and HTML parts, once each. HTML is read only for its link addresses. */
export function messageLinks(payload) {
  const found = new Set();
  const add = raw => {
    const cleaned = raw.replace(/[)\].,;:!?'"]+$/, '');
    try { const url = new URL(cleaned); if (url.protocol === 'http:' || url.protocol === 'https:') found.add(url.href); } catch { /* not a link */ }
  };
  const visit = part => {
    const kind = part.mimeType?.toLowerCase();
    if (kind === 'text/plain' || kind === 'text/html') {
      const text = decodeBase64Url(part.body?.data) ?? '';
      if (kind === 'text/html') for (const match of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(match[1].replace(/&amp;/g, '&'));
      else for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) add(match[0]);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return [...found].slice(0, MOST_LINKS);
}

/** The files a message carries: every MIME part that has a file name. */
export function messageAttachments(payload) {
  const found = [];
  const visit = part => {
    if (part.filename) found.push({ name: part.filename, mime_type: part.mimeType ?? '', size: typeof part.body?.size === 'number' ? part.body.size : null });
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return found;
}

/** Whether a plain-text edit of a draft would discard original MIME media or formatting. */
export const draftNeedsOriginal = part => Boolean(part && (part.filename || part.body?.attachmentId
  || (part.mimeType?.toLowerCase() !== 'text/plain' && part.body?.data)
  || headerOf(part, 'content-id') || part.parts?.some(draftNeedsOriginal)));

const hasCalendarPart = payload => /text\/calendar/i.test(headerOf(payload, 'content-type')) || /text\/calendar/i.test(payload?.mimeType ?? '') || Boolean(payload?.parts?.some(hasCalendarPart));

/** One Gmail message resource as the neutral message row. `draft` is the draft id when it was read as a draft. */
export function toNeutral(provider, message, draft = null) {
  const payload = message.payload;
  return neutralMessage({
    id: message.id,
    thread_id: message.threadId,
    draft_id: draft,
    labels: neutralLabels(provider, message.labelIds),
    date_ms: Number(message.internalDate) || null,
    snippet: message.snippet,
    headers: Object.fromEntries(Object.entries(HEADER_FIELDS).map(([field, name]) => [field, headerOf(payload, name)])),
    has_calendar_invite: hasCalendarPart(payload),
    text: plainTextBody(payload),
    links: messageLinks(payload),
    attachments: messageAttachments(payload),
    needs_original: draftNeedsOriginal(payload) || Boolean(headerOf(payload, 'bcc')),
  });
}

/** A message ready for Gmail's `raw` field: RFC 2822, base64url. */
export function rawMessage({ from, to, cc, subject, text, in_reply_to, references }) {
  const clean = value => String(value).replace(/[\r\n]+/g, ' ').trim();
  const binary = bytes => { let out = ''; for (let at = 0; at < bytes.length; at += 0x8000) out += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); return out; };
  const encodeHeader = value => {
    const plain = clean(value);
    if (/^[\x20-\x7e]*$/.test(plain)) return plain;
    return `=?UTF-8?B?${btoa(binary(new TextEncoder().encode(plain)))}?=`;
  };
  const body64 = btoa(binary(new TextEncoder().encode(String(text ?? '').replace(/\r\n?/g, '\n')))).replace(/.{1,76}/g, '$&\r\n').trimEnd();
  const headers = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    ...(cc && String(cc).trim() ? [`Cc: ${clean(cc)}`] : []),
    `Subject: ${encodeHeader(subject ?? '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const threadAt = headers.findIndex(line => line.startsWith('Subject:')) + 1;
  if (in_reply_to) headers.splice(threadAt, 0, `In-Reply-To: ${clean(in_reply_to)}`);
  if (references) headers.splice(threadAt + (in_reply_to ? 1 : 0), 0, `References: ${clean(references)}`);
  return btoa(binary(new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${body64}`))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const METADATA = {
  headers: ['From', 'To', 'Subject', 'Date'],
  thread: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'],
};

const need = (ctx, input, field) => {
  const value = input[field];
  if (typeof value !== 'string' || !value) throw new ctx.Refused(`Give ${field}.`);
  return value;
};

export const operations = {
  async 'find-my-mailbox'(ctx) {
    const profile = await ctx.call('GET', '/profile');
    if (!profile?.emailAddress) throw new ctx.Refused(ctx.fill(ctx.words.no_address, { label: ctx.provider.label }));
    return { address: profile.emailAddress, cursor: String(profile.historyId ?? ''), messages_total: profile.messagesTotal ?? null, threads_total: profile.threadsTotal ?? null };
  },

  async 'list-new-mail'(ctx, input) {
    const history = await ctx.call('GET', '/history', { query: { startHistoryId: need(ctx, input, 'since'), historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: ctx.provider.history_page_size } });
    const messages = (history?.history ?? []).flatMap(step => (step.messagesAdded ?? []).map(added => added.message)).filter(message => message?.id)
      .map(message => ({ id: message.id, thread_id: message.threadId ?? null, labels: neutralLabels(ctx.provider, message.labelIds) }));
    return { messages, cursor: String(history?.historyId ?? input.since), next_page_token: history?.nextPageToken ?? null };
  },

  async 'find-mail'(ctx, input) {
    const folder = input.folder || 'inbox';
    const typed = typeof input.text === 'string' ? input.text.trim() : '';
    const query = typed || ctx.provider.folders[folder];
    if (!query) throw new ctx.Refused(ctx.fill(ctx.words.no_folder, { label: ctx.provider.label, folder }));
    const found = await ctx.call('GET', '/messages', { query: { q: query, maxResults: ctx.provider.page_size, includeSpamTrash: true, pageToken: input.page_token } });
    return { messages: (found?.messages ?? []).filter(message => message.id).map(message => ({ id: message.id, thread_id: message.threadId ?? null })), next_page_token: found?.nextPageToken ?? null };
  },

  async 'read-mail-headers'(ctx, input) {
    const message = await ctx.call('GET', `/messages/${enc(need(ctx, input, 'message_id'))}`, { query: { format: 'metadata', metadataHeaders: METADATA.headers } });
    return toNeutral(ctx.provider, message);
  },

  async 'read-a-mail'(ctx, input) {
    const message = await ctx.call('GET', `/messages/${enc(need(ctx, input, 'message_id'))}`, { query: { format: 'full' } });
    return toNeutral(ctx.provider, message);
  },

  async 'read-a-conversation'(ctx, input) {
    const thread = await ctx.call('GET', `/threads/${enc(need(ctx, input, 'thread_id'))}`, { query: { format: 'metadata', metadataHeaders: METADATA.thread } });
    return { thread_id: thread?.id ?? input.thread_id, messages: (thread?.messages ?? []).map(message => toNeutral(ctx.provider, message)) };
  },

  async 'organize-mail'(ctx, input) {
    const body = { ...(input.add_labels?.length ? { addLabelIds: wireLabels(ctx.provider, input.add_labels) } : {}), ...(input.remove_labels?.length ? { removeLabelIds: wireLabels(ctx.provider, input.remove_labels) } : {}) };
    const message = await ctx.call('POST', `/messages/${enc(need(ctx, input, 'message_id'))}/modify`, { body });
    return { id: message.id, thread_id: message.threadId ?? null, labels: neutralLabels(ctx.provider, message.labelIds) };
  },

  async 'organize-a-conversation'(ctx, input) {
    const body = { ...(input.add_labels?.length ? { addLabelIds: wireLabels(ctx.provider, input.add_labels) } : {}), ...(input.remove_labels?.length ? { removeLabelIds: wireLabels(ctx.provider, input.remove_labels) } : {}) };
    const thread = await ctx.call('POST', `/threads/${enc(need(ctx, input, 'thread_id'))}/modify`, { body });
    return { thread_id: thread?.id ?? input.thread_id };
  },

  async 'trash-mail'(ctx, input) {
    const message = await ctx.call('POST', `/messages/${enc(need(ctx, input, 'message_id'))}/trash`);
    return { id: message.id, thread_id: message.threadId ?? null, labels: neutralLabels(ctx.provider, message.labelIds) };
  },

  async 'restore-mail'(ctx, input) {
    const message = await ctx.call('POST', `/messages/${enc(need(ctx, input, 'message_id'))}/untrash`);
    return { id: message.id, thread_id: message.threadId ?? null, labels: neutralLabels(ctx.provider, message.labelIds) };
  },

  async 'trash-a-conversation'(ctx, input) {
    const thread = await ctx.call('POST', `/threads/${enc(need(ctx, input, 'thread_id'))}/trash`);
    return { thread_id: thread?.id ?? input.thread_id };
  },

  async 'restore-a-conversation'(ctx, input) {
    const thread = await ctx.call('POST', `/threads/${enc(need(ctx, input, 'thread_id'))}/untrash`);
    return { thread_id: thread?.id ?? input.thread_id };
  },

  async 'list-mail-drafts'(ctx, input) {
    const found = await ctx.call('GET', '/drafts', { query: { maxResults: ctx.provider.page_size, pageToken: input.page_token, q: typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined } });
    return { drafts: (found?.drafts ?? []).filter(draft => draft.id).map(draft => ({ draft_id: draft.id, message_id: draft.message?.id ?? null, thread_id: draft.message?.threadId ?? null })), next_page_token: found?.nextPageToken ?? null };
  },

  async 'read-a-mail-draft'(ctx, input) {
    const draft = await ctx.call('GET', `/drafts/${enc(need(ctx, input, 'draft_id'))}`, { query: { format: 'full' } });
    return { draft_id: draft.id, message: toNeutral(ctx.provider, draft.message, draft.id) };
  },

  async 'save-a-mail-draft'(ctx, input) {
    if (typeof input.to !== 'string' || !input.to.trim()) throw new ctx.Refused('Give to: who the message goes to.');
    const message = { raw: rawMessage(input), ...(input.thread_id ? { threadId: input.thread_id } : {}) };
    const draft = input.draft_id
      ? await ctx.call('PUT', `/drafts/${enc(input.draft_id)}`, { body: { message } })
      : await ctx.call('POST', '/drafts', { body: { message } });
    return { draft_id: draft.id, message_id: draft.message?.id ?? null, thread_id: draft.message?.threadId ?? null };
  },

  async 'delete-a-mail-draft'(ctx, input) {
    const draft = need(ctx, input, 'draft_id');
    await ctx.call('DELETE', `/drafts/${enc(draft)}`);
    return { draft_id: draft, deleted: true };
  },

  async 'send-a-mail-draft'(ctx, input) {
    const sent = await ctx.call('POST', '/drafts/send', { body: { id: need(ctx, input, 'draft_id') } });
    return { message_id: sent?.id ?? null, thread_id: sent?.threadId ?? null };
  },

  async 'list-send-as-addresses'(ctx) {
    const found = await ctx.call('GET', '/settings/sendAs');
    return { addresses: (found?.sendAs ?? []).map(row => ({ address: row.sendAsEmail ?? '', is_primary: row.isPrimary === true, signature: typeof row.signature === 'string' ? row.signature : '' })) };
  },

  async 'set-a-mail-signature'(ctx, input) {
    const address = need(ctx, input, 'address');
    const saved = await ctx.call('PATCH', `/settings/sendAs/${enc(address)}`, { body: { signature: typeof input.signature === 'string' ? input.signature : '' } });
    return { address: saved?.sendAsEmail ?? address, signature: typeof saved?.signature === 'string' ? saved.signature : '' };
  },
};
