// tools/read-and-write-mail/read-data/adapters/outlook.mjs
//
// Purpose: Microsoft Graph's mail wire format and nothing else: each neutral mail operation as Graph requests it
// (https://graph.microsoft.com/v1.0/me: /messages, /mailFolders, drafts, /send) and its replies (message resources,
// isRead, flag, importance, conversationId, folder ids) as the neutral message rows of ../neutral.mjs. Kept as code
// because a wire format is Physics. Reached only through its row in ../mail-providers.json (adapter: "outlook").
//
// What this mailbox cannot do, said plainly: Graph keeps no signature the way a send-as setting does (the row does not
// offer set-a-mail-signature, and a send-as read answers the mailbox's own address with no signature), and a draft
// cannot be given In-Reply-To or References lines (Outlook threads a draft by its subject), so those two are not
// carried.
//
// Non-Negotiable Invariants:
// 1. Only text is handed on as a message's text: Graph is asked for it as text (Prefer: outlook.body-content-type="text").
// 2. A paging address Graph handed over is followed only inside the provider's base_url (mail.mjs `call`).
// 3. A conversation operation touches exactly the messages Graph lists for that conversation id.

import { neutralMessage } from '../neutral.mjs';

const enc = encodeURIComponent;
const LABELLED = ['inbox', 'sent', 'trash'];
const TEXT = { Prefer: 'outlook.body-content-type="text"' };
const LIST_FIELDS = 'id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,bccRecipients,replyTo,isRead,isDraft,flag,importance,internetMessageId,parentFolderId,hasAttachments';
const FULL_FIELDS = `${LIST_FIELDS},body,internetMessageHeaders`;

const address = entry => {
  const found = entry?.emailAddress;
  if (!found?.address) return '';
  const name = (found.name ?? '').trim();
  if (!name || name === found.address) return found.address;
  return /[,;"<>()]/.test(name) ? `"${name.replace(/"/g, '\\"')}" <${found.address}>` : `${name} <${found.address}>`;
};
const list = entries => (Array.isArray(entries) ? entries.map(address).filter(Boolean).join(', ') : '');
const extra = (message, name) => message.internetMessageHeaders?.find(header => header.name?.toLowerCase() === name)?.value?.trim() ?? '';

/** The folder ids of the provider's own folders, read once per run, by neutral folder name. */
function folderIds(ctx) {
  let known = null;
  return () => (known ??= Promise.all(Object.entries(ctx.provider.folders).filter(([neutral]) => LABELLED.includes(neutral)).map(async ([neutral, alias]) => {
    const folder = await ctx.call('GET', `/mailFolders/${enc(alias)}`, { query: { $select: 'id' } });
    return [neutral, folder?.id];
  })).then(pairs => Object.fromEntries(pairs)));
}

const urls = text => [...new Set([...String(text ?? '').matchAll(/https?:\/\/[^\s<>"]+/g)].map(match => match[0].replace(/[)\].,;:!?'"]+$/, '')))]
  .filter(link => { try { return ['http:', 'https:'].includes(new URL(link).protocol); } catch { return false; } }).slice(0, 50);

async function toNeutral(ctx, ids, message, { draft = false, full = false } = {}) {
  const where = await ids();
  const labels = [];
  const parent = message.parentFolderId;
  for (const [neutral, id] of Object.entries(where)) if (id && id === parent && LABELLED.includes(neutral)) labels.push(neutral);
  if (message.isRead === false) labels.push('unread');
  if (message.flag?.flagStatus === 'flagged') labels.push('starred');
  if (message.importance === 'high') labels.push('important');
  if (message.isDraft) labels.push('draft');
  const sentAt = Date.parse(message.receivedDateTime ?? message.sentDateTime ?? '');
  let attachments = [];
  if (full && message.hasAttachments) {
    const found = await ctx.call('GET', `/messages/${enc(message.id)}/attachments`, { query: { $select: 'name,contentType,size' } });
    attachments = (found?.value ?? []).map(file => ({ name: file.name ?? '', mime_type: file.contentType ?? '', size: typeof file.size === 'number' ? file.size : null }));
  }
  const text = full && message.body?.contentType?.toLowerCase() === 'text' ? message.body.content : null;
  return neutralMessage({
    id: message.id,
    thread_id: message.conversationId,
    draft_id: draft ? message.id : null,
    labels,
    date_ms: Number.isFinite(sentAt) ? sentAt : null,
    snippet: message.bodyPreview,
    headers: {
      from: address(message.from),
      to: list(message.toRecipients),
      cc: list(message.ccRecipients),
      bcc: list(message.bccRecipients),
      reply_to: list(message.replyTo),
      subject: message.subject ?? '',
      date: Number.isFinite(sentAt) ? new Date(sentAt).toUTCString() : '',
      message_id: message.internetMessageId ?? '',
      references: extra(message, 'references'),
      in_reply_to: extra(message, 'in-reply-to'),
      list_unsubscribe: extra(message, 'list-unsubscribe'),
    },
    has_calendar_invite: false,
    text,
    links: urls(text),
    attachments,
    needs_original: Boolean(message.hasAttachments) || (message.bccRecipients ?? []).length > 0,
  });
}

const need = (ctx, input, field) => {
  const value = input[field];
  if (typeof value !== 'string' || !value) throw new ctx.Refused(`Give ${field}.`);
  return value;
};

/** The messages Graph lists for one conversation id. */
const ofConversation = async (ctx, thread, select = 'id') => (await ctx.call('GET', '/messages', { query: { $filter: `conversationId eq '${thread.replace(/'/g, "''")}'`, $select: select, $top: 100 } }))?.value ?? [];

/** Applies neutral label changes to one message: Graph keeps read, flag and importance on the message and the rest by folder. */
async function change(ctx, id, add = [], remove = []) {
  const patch = {};
  const moves = [];
  for (const [names, on] of [[add, true], [remove, false]]) {
    for (const name of names) {
      if (name === 'unread') patch.isRead = !on;
      else if (name === 'starred') patch.flag = { flagStatus: on ? 'flagged' : 'notFlagged' };
      else if (name === 'important') patch.importance = on ? 'high' : 'normal';
      else if (name === 'inbox') moves.push(on ? ctx.provider.folders.inbox : ctx.provider.folders.archive);
      else throw new ctx.Refused(ctx.fill(ctx.words.not_offered, { label: ctx.provider.label, job: `change the label ${name}` }));
    }
  }
  let now = id;
  if (Object.keys(patch).length) await ctx.call('PATCH', `/messages/${enc(now)}`, { body: patch });
  for (const destination of moves) now = (await ctx.call('POST', `/messages/${enc(now)}/move`, { body: { destinationId: destination } }))?.id ?? now;
  return now;
}

async function relocate(ctx, id, destination) {
  return (await ctx.call('POST', `/messages/${enc(id)}/move`, { body: { destinationId: destination } }))?.id ?? id;
}

async function nowLabelled(ctx, ids, id) {
  const message = await ctx.call('GET', `/messages/${enc(id)}`, { query: { $select: LIST_FIELDS } });
  const row = await toNeutral(ctx, ids, message);
  return { id: row.id, thread_id: row.thread_id, labels: row.labels };
}

export const operations = {
  async 'find-my-mailbox'(ctx) {
    const me = await ctx.call('GET', '', { query: { $select: 'mail,userPrincipalName' } });
    const mailbox = me?.mail || me?.userPrincipalName;
    if (!mailbox) throw new ctx.Refused(ctx.fill(ctx.words.no_address, { label: ctx.provider.label }));
    return { address: mailbox, cursor: new Date().toISOString(), messages_total: null, threads_total: null };
  },

  async 'list-new-mail'(ctx, input) {
    const since = need(ctx, input, 'since');
    const found = await ctx.call('GET', `/mailFolders/${enc(ctx.provider.folders.inbox)}/messages`, { query: { $filter: `receivedDateTime gt ${since}`, $select: 'id,conversationId,receivedDateTime', $orderby: 'receivedDateTime asc', $top: ctx.provider.history_page_size } });
    const rows = found?.value ?? [];
    return { messages: rows.map(row => ({ id: row.id, thread_id: row.conversationId ?? null, labels: ['inbox'] })), cursor: rows.length ? rows[rows.length - 1].receivedDateTime : since, next_page_token: found?.['@odata.nextLink'] ?? null };
  },

  async 'find-mail'(ctx, input) {
    const typed = typeof input.text === 'string' ? input.text.trim() : '';
    const folder = input.folder || 'inbox';
    if (input.page_token) {
      const next = await ctx.call('GET', input.page_token);
      return { messages: (next?.value ?? []).map(row => ({ id: row.id, thread_id: row.conversationId ?? null })), next_page_token: next?.['@odata.nextLink'] ?? null };
    }
    let path = '/messages';
    const query = { $select: 'id,conversationId', $top: ctx.provider.page_size };
    if (typed) query.$search = `"${typed.replace(/"/g, '')}"`;
    else if (folder === 'starred') query.$filter = "flag/flagStatus eq 'flagged'";
    else if (folder === 'all') path = '/messages';
    else if (ctx.provider.folders[folder]) path = `/mailFolders/${enc(ctx.provider.folders[folder])}/messages`;
    else throw new ctx.Refused(ctx.fill(ctx.words.no_folder, { label: ctx.provider.label, folder }));
    const found = await ctx.call('GET', path, { query });
    return { messages: (found?.value ?? []).map(row => ({ id: row.id, thread_id: row.conversationId ?? null })), next_page_token: found?.['@odata.nextLink'] ?? null };
  },

  async 'read-mail-headers'(ctx, input) {
    const message = await ctx.call('GET', `/messages/${enc(need(ctx, input, 'message_id'))}`, { query: { $select: LIST_FIELDS }, headers: TEXT });
    return toNeutral(ctx, folderIds(ctx), message);
  },

  async 'read-a-mail'(ctx, input) {
    const message = await ctx.call('GET', `/messages/${enc(need(ctx, input, 'message_id'))}`, { query: { $select: FULL_FIELDS }, headers: TEXT });
    return toNeutral(ctx, folderIds(ctx), message, { full: true });
  },

  async 'read-a-conversation'(ctx, input) {
    const thread = need(ctx, input, 'thread_id');
    const ids = folderIds(ctx);
    const rows = await ofConversation(ctx, thread, LIST_FIELDS);
    return { thread_id: thread, messages: await Promise.all(rows.map(row => toNeutral(ctx, ids, row))) };
  },

  async 'organize-mail'(ctx, input) {
    const now = await change(ctx, need(ctx, input, 'message_id'), input.add_labels, input.remove_labels);
    return nowLabelled(ctx, folderIds(ctx), now);
  },

  async 'organize-a-conversation'(ctx, input) {
    const thread = need(ctx, input, 'thread_id');
    for (const row of await ofConversation(ctx, thread)) await change(ctx, row.id, input.add_labels, input.remove_labels);
    return { thread_id: thread };
  },

  async 'trash-mail'(ctx, input) {
    return nowLabelled(ctx, folderIds(ctx), await relocate(ctx, need(ctx, input, 'message_id'), ctx.provider.folders.trash));
  },

  async 'restore-mail'(ctx, input) {
    return nowLabelled(ctx, folderIds(ctx), await relocate(ctx, need(ctx, input, 'message_id'), ctx.provider.folders.inbox));
  },

  async 'trash-a-conversation'(ctx, input) {
    const thread = need(ctx, input, 'thread_id');
    for (const row of await ofConversation(ctx, thread)) await relocate(ctx, row.id, ctx.provider.folders.trash);
    return { thread_id: thread };
  },

  async 'restore-a-conversation'(ctx, input) {
    const thread = need(ctx, input, 'thread_id');
    for (const row of await ofConversation(ctx, thread)) await relocate(ctx, row.id, ctx.provider.folders.inbox);
    return { thread_id: thread };
  },

  async 'list-mail-drafts'(ctx, input) {
    const typed = typeof input.text === 'string' ? input.text.trim() : '';
    const found = input.page_token
      ? await ctx.call('GET', input.page_token)
      : await ctx.call('GET', `/mailFolders/${enc(ctx.provider.folders.drafts)}/messages`, { query: { $select: 'id,conversationId', $top: ctx.provider.page_size, ...(typed ? { $search: `"${typed.replace(/"/g, '')}"` } : {}) } });
    return { drafts: (found?.value ?? []).map(row => ({ draft_id: row.id, message_id: row.id, thread_id: row.conversationId ?? null })), next_page_token: found?.['@odata.nextLink'] ?? null };
  },

  async 'read-a-mail-draft'(ctx, input) {
    const id = need(ctx, input, 'draft_id');
    const message = await ctx.call('GET', `/messages/${enc(id)}`, { query: { $select: FULL_FIELDS }, headers: TEXT });
    return { draft_id: id, message: await toNeutral(ctx, folderIds(ctx), message, { draft: true, full: true }) };
  },

  async 'save-a-mail-draft'(ctx, input) {
    if (typeof input.to !== 'string' || !input.to.trim()) throw new ctx.Refused('Give to: who the message goes to.');
    const people = text => String(text ?? '').split(',').map(part => part.trim()).filter(Boolean).map(part => {
      const match = /^(.*)<([^>]+)>\s*$/.exec(part);
      return { emailAddress: match ? { address: match[2].trim(), name: match[1].replace(/^\s*"|"\s*$/g, '').trim() } : { address: part } };
    });
    const body = { subject: input.subject ?? '', body: { contentType: 'text', content: input.text ?? '' }, toRecipients: people(input.to), ccRecipients: people(input.cc) };
    const draft = input.draft_id
      ? await ctx.call('PATCH', `/messages/${enc(input.draft_id)}`, { body })
      : await ctx.call('POST', '/messages', { body });
    return { draft_id: draft.id, message_id: draft.id, thread_id: draft.conversationId ?? null };
  },

  async 'delete-a-mail-draft'(ctx, input) {
    const id = need(ctx, input, 'draft_id');
    await ctx.call('DELETE', `/messages/${enc(id)}`);
    return { draft_id: id, deleted: true };
  },

  async 'send-a-mail-draft'(ctx, input) {
    const id = need(ctx, input, 'draft_id');
    await ctx.call('POST', `/messages/${enc(id)}/send`);
    return { message_id: id, thread_id: null };
  },

  async 'list-send-as-addresses'(ctx) {
    const me = await ctx.call('GET', '', { query: { $select: 'mail,userPrincipalName' } });
    const mailbox = me?.mail || me?.userPrincipalName;
    return { addresses: mailbox ? [{ address: mailbox, is_primary: true, signature: null }] : [] };
  },
};
