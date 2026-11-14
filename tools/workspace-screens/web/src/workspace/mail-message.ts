// The mail screens read one provider-neutral message row, whatever provider the mailbox is on (the answer of the mail
// tools in tools/read-and-write-mail, read-data/neutral.mjs). The provider's wire format (MIME parts, label ids, send-as
// settings, raw messages) is decoded and composed there, behind the provider's row, and never reaches a screen: this
// module holds only what is true of any mail, so a screen shows a message the same on every provider.
export type MailHeaders = {
  from: string; to: string; cc: string; bcc: string; reply_to: string; subject: string; date: string;
  message_id: string; references: string; in_reply_to: string; list_unsubscribe: string;
};
export type MailAttachment = { name: string; mime_type: string; size: number | null };
export type MailMessage = {
  id: string;
  thread_id: string | null;
  draft_id: string | null;
  labels: string[];
  date_ms: number | null;
  snippet: string;
  headers: MailHeaders;
  has_calendar_invite: boolean;
  text: string | null;
  links: string[];
  attachments: MailAttachment[];
  needs_original: boolean;
};
export type MailIdentity = { address: string; is_primary: boolean; signature: string | null };

/** The one address the provider declares primary; never guessed from list order or an alias label. */
export function primaryMailAddress(addresses: readonly MailIdentity[] | undefined, providerLabel: string): MailIdentity {
  if (!Array.isArray(addresses)) throw new Error(`${providerLabel} did not return the addresses this mailbox sends as.`);
  const primary = addresses.filter(row => row?.is_primary === true);
  if (primary.length !== 1) throw new Error(primary.length ? `${providerLabel} returned more than one primary address.` : `${providerLabel} returned no primary address.`);
  if (typeof primary[0].address !== 'string' || !primary[0].address.trim()) throw new Error(`${providerLabel} returned a primary address without an email address.`);
  return primary[0];
}

/** Split an address header without splitting commas inside a display name or angle-bracket address. */
export function splitEmailAddresses(value: string): string[] {
  const result: string[] = [];
  let quoted = false;
  let angleDepth = 0;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === '<') angleDepth += 1;
    else if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (!quoted && angleDepth === 0 && character === ',') {
      const address = value.slice(start, index).trim();
      if (address) result.push(address);
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push(last);
  return result;
}

/** The address inside "Name <address>", or the words as they are. */
export const mailAddress = (value: string): string => (/<([^>]+)>\s*$/.exec(value)?.[1] ?? value).trim();
/** The name in "Name <address>", else the address. */
export const mailName = (value: string): string => value.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || mailAddress(value);
const validAddress = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

/** A recipients line the person typed: every address valid and none carrying a line break; the addresses, or null. */
export function mailRecipients(value: string): string[] | null {
  if (/[\r\n]/.test(value)) return null;
  const rows = splitEmailAddresses(value.replace(/;/g, ','));
  return rows.length && rows.every(row => validAddress(mailAddress(row))) ? rows : null;
}

/** Who a reply-all goes to: the sender (or reply-to) on the To line, and everyone else on To and Cc, minus this mailbox and repeats. */
export function replyAllRecipients(headers: Pick<MailHeaders, 'reply_to' | 'from' | 'to' | 'cc'> | undefined, mailbox: string): { to: string[]; cc: string[] } {
  const self = mailbox.trim().toLowerCase();
  const seen = new Set<string>();
  const take = (rows: string[]) => rows.filter(row => {
    const key = mailAddress(row).toLowerCase();
    if (!key || key === self || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const to = take(splitEmailAddresses(headers?.reply_to || headers?.from || ''));
  const cc = take([...splitEmailAddresses(headers?.to ?? ''), ...splitEmailAddresses(headers?.cc ?? '')]);
  return { to, cc };
}

export type MailParticipant = { name: string; address: string };
/** Everyone a set of messages names (sender, To, Cc), once each, in the order first named. */
export function mailParticipants(messages: readonly (MailMessage | undefined)[]): MailParticipant[] {
  const seen = new Map<string, MailParticipant>();
  for (const message of messages) {
    for (const field of ['from', 'to', 'cc'] as const) {
      for (const row of splitEmailAddresses(message?.headers?.[field] ?? '')) {
        const address = mailAddress(row);
        const key = address.toLowerCase();
        if (key && !seen.has(key)) seen.set(key, { name: mailName(row), address });
      }
    }
  }
  return [...seen.values()];
}

/** The words a forward opens with: a marker line, the original's header lines, then its text. `labels` are the caller's words. */
export function forwardBody(message: MailMessage | undefined, labels: { marker: string; from: string; date: string; subject: string; to: string }): string {
  const headers = message?.headers;
  const lines = [labels.marker, `${labels.from}: ${headers?.from ?? ''}`, `${labels.date}: ${headers?.date ?? ''}`, `${labels.subject}: ${headers?.subject ?? ''}`, `${labels.to}: ${headers?.to ?? ''}`, '', message?.text ?? ''];
  return `\n\n${lines.join('\n')}`;
}

const htmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A signature (HTML) as plain lines. `lossy` is true when markup beyond line breaks, paragraphs and entities was dropped. */
export function signatureText(html: string): { text: string; lossy: boolean } {
  const lossy = /<(?!\/?(br|div|p|span)\b)[a-z]/i.test(html) || /<(div|p|span)\b[^>]*\s(style|class|href)=/i.test(html);
  const text = html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<(div|p)\b[^>]*>/gi, '\n').replace(/<\/(div|p)>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (_, name: string) => name[0] === '#' ? String.fromCodePoint(Number(name.slice(1))) : htmlEntities[name.toLowerCase()] ?? `&${name};`)
    .replace(/\n{3,}/g, '\n\n').trim();
  return { text, lossy };
}
/** Plain signature lines as the HTML a provider takes: escaped, one `<br>` per line. */
export const signatureHtml = (text: string): string => text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

export type MailThreadView = { threadId: string; messages: MailMessage[]; earlier: number };
/**
 * A conversation as the conversation read gives it (headers only), oldest first, without its drafts (a draft has its
 * own folder). Only the latest `most` messages are kept; `earlier` counts the ones left out, so a long conversation is
 * a bounded read and a bounded screen, and the rest is said to be at the provider.
 */
export function mailThreadView(threadId: string, messages: readonly MailMessage[] | undefined, most: number): MailThreadView {
  const sent = (messages ?? []).filter(message => message?.id && !message.labels?.includes('draft'))
    .map((message, index) => ({ message, index, at: message.date_ms ?? 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(row => row.message);
  return { threadId, messages: sent.slice(-most), earlier: Math.max(0, sent.length - most) };
}

/** A provider's web page for one message or draft, from its row's template (`{mailbox}` and `{id}`). */
export const mailWebLink = (template: string, mailbox: string, id: string): string => template.replace('{mailbox}', encodeURIComponent(mailbox)).replace('{id}', encodeURIComponent(id));
