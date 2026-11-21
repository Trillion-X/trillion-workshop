// tools/read-and-write-mail/read-data/adapters/agentmail.mjs
//
// Purpose: AgentMail's wire format and nothing else: each neutral mail operation as AgentMail's REST API requests it
// (https://api.agentmail.to/v0: /inboxes, /inboxes/{inbox_id}/messages, .../messages/search, .../messages/{message_id},
// .../threads/{thread_id}) and its replies (inbox, message and thread resources, labels, headers, attachments) as the
// neutral message rows of ../neutral.mjs. Kept as code because a wire format is Physics. Reached only through its row in
// ../mail-providers.json (adapter: "agentmail"), with the key the vault holds under the row's secret_name.
//
// AgentMail keeps messages and threads inside an inbox, so a neutral id names its inbox first: `<inbox_id>/<message_id>`
// and `<inbox_id>/<thread_id>` (an inbox id has no "/"). A neutral id is given back exactly as a list answered it.
// An operation that is not about one message (find, list new mail) asks every inbox the key reaches, in turn.
//
// What this mailbox does not offer, said plainly: a send, a draft, a label change and a trash are not in the row's
// operations, so they are refused in words before any request leaves.
//
// Non-Negotiable Invariants:
// 1. A message's text is its plain-text part. When a message has only an HTML part, its text is that part converted to
//    plain text (neutral.mjs htmlToText), never the HTML itself; its links are read from both.
// 2. The page token an operation hands back carries each inbox's own next page, so the next call continues every inbox
//    where it stopped and never restarts one.
// 3. A deactivated inbox is not asked, since it neither sends nor receives mail.

import { htmlToText, linksIn, neutralLabels, neutralMessage } from '../neutral.mjs';

const enc = encodeURIComponent;
const PAGE_OF_INBOXES = 100;

const join = (inbox, id) => `${inbox}/${id}`;

const need = (ctx, input, field) => {
  const value = input[field];
  if (typeof value !== 'string' || !value) throw new ctx.Refused(`Give ${field}.`);
  return value;
};

/** The inbox and the id a neutral id names. */
function split(ctx, value, field) {
  const at = typeof value === 'string' ? value.indexOf('/') : -1;
  if (at <= 0 || at === value.length - 1) throw new ctx.Refused(`Give ${field} as a list answered it: the inbox id, a slash, then the id.`);
  return { inbox: value.slice(0, at), id: value.slice(at + 1) };
}

const sealed = pending => (pending.length ? Buffer.from(JSON.stringify(pending)).toString('base64url') : null);

function opened(ctx, token) {
  try {
    const pending = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (Array.isArray(pending) && pending.every(pair => Array.isArray(pair) && typeof pair[0] === 'string')) return pending;
  } catch { /* refused below */ }
  throw new ctx.Refused('Give the page token a previous call answered, unchanged.');
}

/** Every inbox the key reaches that is not deactivated. */
async function inboxesOf(ctx) {
  const found = [];
  let page = null;
  do {
    const reply = await ctx.call('GET', '/inboxes', { query: { limit: PAGE_OF_INBOXES, page_token: page } });
    found.push(...(reply?.inboxes ?? []));
    page = reply?.next_page_token ?? null;
  } while (page);
  return found.filter(inbox => inbox.inbox_id && inbox.status !== 'deactivated');
}

/** One page from each inbox still in play. `ask(inbox, pageToken)` answers `{ messages, next_page_token }`. The first call
 *  starts every inbox; a page token carries the inboxes that have more pages, each with its own token. */
async function pagesAcross(ctx, input, ask) {
  const pending = input.page_token ? opened(ctx, input.page_token) : (await inboxesOf(ctx)).map(inbox => [inbox.inbox_id, null]);
  const pages = [];
  const next = [];
  for (const [inbox, token] of pending) {
    const reply = await ask(inbox, token);
    pages.push({ inbox, messages: reply?.messages ?? [] });
    if (reply?.next_page_token) next.push([inbox, reply.next_page_token]);
  }
  return { pages, next_page_token: sealed(next) };
}

const list = entries => (Array.isArray(entries) ? entries.join(', ') : '');

function headerOf(message, name) {
  const wanted = name.toLowerCase();
  const found = Object.entries(message.headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return typeof found?.[1] === 'string' ? found[1].trim() : '';
}

function bodyText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (typeof message.html === 'string' && message.html.trim()) return htmlToText(message.html);
  return null;
}

const hrefsIn = html => [...String(html ?? '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]).join('\n');

/** One AgentMail message (a message resource, or a thread's message) as the neutral row. */
function toNeutral(ctx, inbox, message, { full = false, thread = null } = {}) {
  const sentAt = Date.parse(message.timestamp ?? '');
  const text = full ? bodyText(message) : null;
  const attachments = full ? (message.attachments ?? []).map(file => ({ name: file.filename ?? '', mime_type: file.content_type ?? '', size: typeof file.size === 'number' ? file.size : null })) : [];
  return neutralMessage({
    id: join(inbox, message.message_id),
    thread_id: join(inbox, message.thread_id ?? thread),
    labels: neutralLabels(ctx.provider, message.labels),
    date_ms: Number.isFinite(sentAt) ? sentAt : null,
    snippet: message.preview ?? '',
    headers: {
      from: message.from ?? '',
      to: list(message.to),
      cc: list(message.cc),
      bcc: list(message.bcc),
      reply_to: list(message.reply_to),
      subject: message.subject ?? '',
      date: Number.isFinite(sentAt) ? new Date(sentAt).toUTCString() : '',
      message_id: headerOf(message, 'message-id'),
      references: headerOf(message, 'references') || list(message.references),
      in_reply_to: headerOf(message, 'in-reply-to') || message.in_reply_to || '',
      list_unsubscribe: headerOf(message, 'list-unsubscribe'),
    },
    has_calendar_invite: Boolean(message.calendar_event_id),
    text,
    links: full ? linksIn(`${text ?? ''}\n${hrefsIn(message.html)}`) : [],
    attachments,
    needs_original: attachments.length > 0 || (message.bcc ?? []).length > 0,
  });
}

async function messageOf(ctx, input, { full }) {
  const { inbox, id } = split(ctx, need(ctx, input, 'message_id'), 'message_id');
  const message = await ctx.call('GET', `/inboxes/${enc(inbox)}/messages/${enc(id)}`);
  return toNeutral(ctx, inbox, message, { full });
}

export const operations = {
  async 'find-my-mailbox'(ctx) {
    const [first] = await inboxesOf(ctx);
    if (!first?.email) throw new ctx.Refused(ctx.fill(ctx.words.no_address, { label: ctx.provider.label }));
    return { address: first.email, cursor: new Date().toISOString(), messages_total: null, threads_total: null };
  },

  async 'list-new-mail'(ctx, input) {
    const since = need(ctx, input, 'since');
    const { pages, next_page_token } = await pagesAcross(ctx, input, async (inbox, page_token) => {
      const reply = await ctx.call('GET', `/inboxes/${enc(inbox)}/messages`, { query: { labels: ['received'], after: since, ascending: true, limit: ctx.provider.page_size, page_token } });
      return { messages: reply?.messages ?? [], next_page_token: reply?.next_page_token ?? null };
    });
    const messages = pages.flatMap(({ inbox, messages: items }) => items.map(item => ({ id: join(inbox, item.message_id), thread_id: join(inbox, item.thread_id), labels: neutralLabels(ctx.provider, item.labels) })));
    const newest = pages.flatMap(page => page.messages.map(item => item.timestamp)).filter(Boolean).sort().pop();
    return { messages, cursor: newest ?? since, next_page_token };
  },

  async 'find-mail'(ctx, input) {
    const typed = typeof input.text === 'string' ? input.text.trim() : '';
    const folder = input.folder || 'inbox';
    if (!typed && !Object.hasOwn(ctx.provider.folders, folder)) throw new ctx.Refused(ctx.fill(ctx.words.no_folder, { label: ctx.provider.label, folder }));
    const label = ctx.provider.folders[folder];
    const { pages, next_page_token } = await pagesAcross(ctx, input, async (inbox, page_token) => {
      const reply = typed
        ? await ctx.call('GET', `/inboxes/${enc(inbox)}/messages/search`, { query: { q: typed, limit: ctx.provider.page_size, page_token } })
        : await ctx.call('GET', `/inboxes/${enc(inbox)}/messages`, { query: { labels: label ? [label] : undefined, include_trash: folder === 'trash' || folder === 'all' || undefined, limit: ctx.provider.page_size, page_token } });
      return { messages: reply?.messages ?? [], next_page_token: reply?.next_page_token ?? null };
    });
    return { messages: pages.flatMap(({ inbox, messages: items }) => items.map(item => ({ id: join(inbox, item.message_id), thread_id: join(inbox, item.thread_id) }))), next_page_token };
  },

  async 'read-mail-headers'(ctx, input) {
    return messageOf(ctx, input, { full: false });
  },

  async 'read-a-mail'(ctx, input) {
    return messageOf(ctx, input, { full: true });
  },

  async 'read-a-conversation'(ctx, input) {
    const { inbox, id: thread } = split(ctx, need(ctx, input, 'thread_id'), 'thread_id');
    const messages = [];
    let page = null;
    do {
      const reply = await ctx.call('GET', `/inboxes/${enc(inbox)}/threads/${enc(thread)}`, { query: { limit: 100, page_token: page } });
      messages.push(...(reply?.messages ?? []));
      page = reply?.next_page_token ?? null;
    } while (page);
    const rows = messages.map(message => toNeutral(ctx, inbox, message, { full: true, thread }));
    return { thread_id: join(inbox, thread), messages: rows.sort((a, b) => (a.date_ms ?? 0) - (b.date_ms ?? 0)) };
  },

  async 'list-send-as-addresses'(ctx) {
    const inboxes = await inboxesOf(ctx);
    return { addresses: inboxes.filter(inbox => inbox.email).map((inbox, at) => ({ address: inbox.email, is_primary: at === 0, signature: inbox.signature?.text ?? null })) };
  },
};
