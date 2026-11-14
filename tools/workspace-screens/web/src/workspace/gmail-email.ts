// Gmail's MIME response is DATA. Only decoded text/plain parts are handed to the shared email reader;
// HTML parts are deliberately left for Gmail, where their original formatting and links remain intact.
export type GmailHeader = { name?: string; value?: string };
export type GmailPayload = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  headers?: GmailHeader[];
  parts?: GmailPayload[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPayload;
};

export type GmailSendAs = {
  sendAsEmail?: string;
  isPrimary?: boolean;
  signature?: string;
  [field: string]: unknown;
};

export function gmailHeader(payload: GmailPayload | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return payload?.headers?.find(header => header.name?.toLowerCase() === wanted)?.value?.trim() ?? '';
}

/** Select the one provider-declared primary SendAs identity; never guess from list order or an alias label. */
export function primaryGmailSendAs(sendAs: readonly GmailSendAs[] | undefined): GmailSendAs {
  if (!Array.isArray(sendAs)) throw new Error('Gmail did not return its SendAs identities.');
  const primary = sendAs.filter(row => row?.isPrimary === true);
  if (primary.length !== 1) throw new Error(primary.length ? 'Gmail returned more than one primary SendAs identity.' : 'Gmail returned no primary SendAs identity.');
  if (typeof primary[0].sendAsEmail !== 'string' || !primary[0].sendAsEmail.trim()) throw new Error('Gmail returned a primary SendAs identity without an email address.');
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

export function decodeGmailBase64Url(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/** Return only plain-text MIME content; never pass an HTML part to a renderer. */
export function plainTextBody(payload: GmailPayload | undefined): string | null {
  if (!payload) return null;
  const candidates: string[] = [];
  const visit = (part: GmailPayload) => {
    if (part.mimeType?.toLowerCase() === 'text/plain') {
      const decoded = decodeGmailBase64Url(part.body?.data);
      if (decoded?.trim()) candidates.push(decoded.trim());
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return candidates[0] ?? null;
}

export function gmailMessageUrl(messageId: string, email = ''): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(messageId)}`;
}

export function gmailRawMessage(args: { from: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const cleanHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  const encodeHeader = (value: string) => {
    const clean = cleanHeader(value);
    if (/^[\x20-\x7e]*$/.test(clean)) return clean;
    const bytes = new TextEncoder().encode(clean);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `=?UTF-8?B?${btoa(binary)}?=`;
  };
  const bytes = new TextEncoder().encode(args.body.replace(/\r\n?/g, '\n'));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const body64 = btoa(binary).replace(/.{1,76}/g, '$&\r\n').trimEnd();
  const headers = [
    `From: ${cleanHeader(args.from)}`,
    `To: ${cleanHeader(args.to)}`,
    ...(args.cc?.trim() ? [`Cc: ${cleanHeader(args.cc)}`] : []),
    `Subject: ${encodeHeader(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const threadAt = headers.findIndex(line => line.startsWith('Subject:')) + 1;
  if (args.inReplyTo) headers.splice(threadAt, 0, `In-Reply-To: ${cleanHeader(args.inReplyTo)}`);
  if (args.references) headers.splice(threadAt + (args.inReplyTo ? 1 : 0), 0, `References: ${cleanHeader(args.references)}`);
  const rawBytes = new TextEncoder().encode(headers.join('\r\n') + '\r\n\r\n' + body64);
  let rawBinary = '';
  for (let offset = 0; offset < rawBytes.length; offset += 0x8000) rawBinary += String.fromCharCode(...rawBytes.subarray(offset, offset + 0x8000));
  return btoa(rawBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Editing a plain-text draft must not discard original MIME media or formatting. */
export function gmailDraftNeedsOriginal(part: GmailPayload | undefined): boolean {
  return Boolean(part && (part.filename || (part.body as { attachmentId?: string } | undefined)?.attachmentId
    || (part.mimeType?.toLowerCase() !== 'text/plain' && part.body?.data)
    || gmailHeader(part, 'content-id') || part.parts?.some(gmailDraftNeedsOriginal)));
}

/** The address inside "Name <address>", or the words as they are. */
export const gmailAddress = (value: string): string => (/<([^>]+)>\s*$/.exec(value)?.[1] ?? value).trim();
/** The name in "Name <address>", else the address. */
export const gmailName = (value: string): string => value.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || gmailAddress(value);
const validAddress = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

/** A recipients line the person typed: every address valid and none carrying a line break; the addresses, or null. */
export function gmailRecipients(value: string): string[] | null {
  if (/[\r\n]/.test(value)) return null;
  const rows = splitEmailAddresses(value.replace(/;/g, ','));
  return rows.length && rows.every(row => validAddress(gmailAddress(row))) ? rows : null;
}

/** Who a reply-all goes to: the sender (or reply-to) on the To line, and everyone else on To and Cc, minus this mailbox and repeats. */
export function replyAllRecipients(payload: GmailPayload | undefined, mailbox: string): { to: string[]; cc: string[] } {
  const self = mailbox.trim().toLowerCase();
  const seen = new Set<string>();
  const take = (rows: string[]) => rows.filter(row => {
    const key = gmailAddress(row).toLowerCase();
    if (!key || key === self || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const to = take(splitEmailAddresses(gmailHeader(payload, 'reply-to') || gmailHeader(payload, 'from')));
  const cc = take([...splitEmailAddresses(gmailHeader(payload, 'to')), ...splitEmailAddresses(gmailHeader(payload, 'cc'))]);
  return { to, cc };
}

export type GmailParticipant = { name: string; address: string };
/** Everyone a set of messages names (sender, To, Cc), once each, in the order first named. */
export function gmailParticipants(payloads: readonly (GmailPayload | undefined)[]): GmailParticipant[] {
  const seen = new Map<string, GmailParticipant>();
  for (const payload of payloads) {
    for (const name of ['from', 'to', 'cc']) {
      for (const row of splitEmailAddresses(gmailHeader(payload, name))) {
        const address = gmailAddress(row);
        const key = address.toLowerCase();
        if (key && !seen.has(key)) seen.set(key, { name: gmailName(row), address });
      }
    }
  }
  return [...seen.values()];
}

export type GmailAttachment = { name: string; mimeType: string; size: number | null };
/** The files a message carries: every MIME part that has a file name. */
export function gmailAttachments(payload: GmailPayload | undefined): GmailAttachment[] {
  const found: GmailAttachment[] = [];
  const visit = (part: GmailPayload) => {
    if (part.filename) found.push({ name: part.filename, mimeType: part.mimeType ?? '', size: typeof part.body?.size === 'number' ? part.body.size : null });
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return found;
}

const MOST_LINKS = 50;
/** The web links in a message's text and HTML parts, once each. HTML is read only for its link addresses; it is never drawn. */
export function gmailLinks(payload: GmailPayload | undefined): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/[)\].,;:!?'"]+$/, '');
    try { const url = new URL(cleaned); if (url.protocol === 'http:' || url.protocol === 'https:') found.add(url.href); } catch { /* not a link */ }
  };
  const visit = (part: GmailPayload) => {
    const kind = part.mimeType?.toLowerCase();
    if (kind === 'text/plain' || kind === 'text/html') {
      const text = decodeGmailBase64Url(part.body?.data) ?? '';
      if (kind === 'text/html') for (const match of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(match[1].replace(/&amp;/g, '&'));
      else for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) add(match[0]);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return [...found].slice(0, MOST_LINKS);
}

/** The words a forward opens with: a marker line, the original's header lines, then its text. `labels` are the caller's words. */
export function gmailForwardBody(payload: GmailPayload | undefined, labels: { marker: string; from: string; date: string; subject: string; to: string }): string {
  const lines = [labels.marker, `${labels.from}: ${gmailHeader(payload, 'from')}`, `${labels.date}: ${gmailHeader(payload, 'date')}`, `${labels.subject}: ${gmailHeader(payload, 'subject')}`, `${labels.to}: ${gmailHeader(payload, 'to')}`, '', plainTextBody(payload) ?? ''];
  return `\n\n${lines.join('\n')}`;
}

const htmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A Gmail signature (HTML) as plain lines. `lossy` is true when markup beyond line breaks, paragraphs and entities was dropped. */
export function signatureText(html: string): { text: string; lossy: boolean } {
  const lossy = /<(?!\/?(br|div|p|span)\b)[a-z]/i.test(html) || /<(div|p|span)\b[^>]*\s(style|class|href)=/i.test(html);
  const text = html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<(div|p)\b[^>]*>/gi, '\n').replace(/<\/(div|p)>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (_, name: string) => name[0] === '#' ? String.fromCodePoint(Number(name.slice(1))) : htmlEntities[name.toLowerCase()] ?? `&${name};`)
    .replace(/\n{3,}/g, '\n\n').trim();
  return { text, lossy };
}
/** Plain signature lines as the HTML Gmail takes: escaped, one `<br>` per line. */
export const signatureHtml = (text: string): string => text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

export type GmailThreadView = { threadId: string; messages: GmailMessage[]; earlier: number };
/**
 * A conversation as Gmail's thread read gives it (headers only), oldest first, without its drafts (a draft has its own
 * folder). Only the latest `most` messages are kept; `earlier` counts the ones left out, so a long conversation is a
 * bounded read and a bounded screen, and the rest is said to be in Gmail.
 */
export function gmailThreadView(threadId: string, messages: readonly GmailMessage[] | undefined, most: number): GmailThreadView {
  const sent = (messages ?? []).filter(message => message?.id && !message.labelIds?.includes('DRAFT'))
    .map((message, index) => ({ message, index, at: Number(message.internalDate) || 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(row => row.message);
  return { threadId, messages: sent.slice(-most), earlier: Math.max(0, sent.length - most) };
}
