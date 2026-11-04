// src/money-out-mail.mjs
//
// What a payment mail says it cost: from one Gmail message (the full read: its headers and its body parts), the merchant,
// the amount paid, when, and the plan. Every pattern and word list is DATA in src/money-sources.json (`mail`). A mail
// with no paid amount, or one that is a refund, is not a payment: null.

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = word => new RegExp(`\\b${escape(word)}\\b`, 'gi');
const cleanName = text => text
  .replace(/\s+#.*$/, '')
  .replace(/^[\s"'“”.,;:|–—-]+|[\s"'“”.,;:|–—-]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();
export const isoOf = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function paymentFromMail(message, rules) {
  if (!message?.id) return null;
  const headers = Object.fromEntries((message.payload?.headers ?? []).map(header => [String(header.name).toLowerCase(), String(header.value ?? '')]));
  const subject = headers.subject ?? '';
  if (rules.skip_subjects.some(phrase => subject.toLowerCase().includes(phrase))) return null;
  const amount = amountOf(bodiesOf(message.payload), rules);
  if (amount === null) return null;
  const merchant = merchantOf(subject, headers.from ?? '', rules);
  const at = isoOf(message.internalDate !== undefined ? Number(message.internalDate) : headers.date);
  return { id: message.id, merchant, amount, at, plan: planOf(subject, merchant, rules) };
}

// The text plain first, the html (tags stripped) when the plain text says no amount.
function bodiesOf(payload) {
  const found = { plain: [], html: [] };
  const walk = part => {
    if (!part) return;
    const data = part.body?.data;
    if (data && part.mimeType === 'text/plain') found.plain.push(decodeBase64Url(data));
    else if (data && part.mimeType === 'text/html') found.html.push(decodeBase64Url(data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { plain: found.plain.join('\n'), html: stripHtml(found.html.join('\n')) };
}

function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Block tags end a line and table cells end a word, so "Amount paid" and "$16.00" in two cells read as one line.
function stripHtml(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&#36;/g, '$')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function amountOf({ plain, html }, rules) {
  for (const text of [plain, html]) {
    const amount = amountIn(text, rules);
    if (amount !== null) return amount;
  }
  return null;
}

// The first money amount on a line that says what was paid; a line about a refund, a credit or a balance says nothing
// of what was paid unless it also says total.
function amountIn(text, rules) {
  const money = new RegExp(rules.amount, 'i');
  const words = new RegExp(`\\b(${rules.amount_words.map(escape).join('|')})\\b`, 'i');
  const skip = new RegExp(`\\b(${rules.skip_words.map(escape).join('|')})\\b`, 'i');
  const unless = new RegExp(`\\b${escape(rules.skip_words_unless)}\\b`, 'i');
  for (const line of text.split('\n')) {
    if (!words.test(line) || (skip.test(line) && !unless.test(line))) continue;
    const found = money.exec(line);
    const value = found ? Number(found[1].replace(/,/g, '')) : 0;
    if (value > 0) return value;
  }
  return null;
}

// The merchant the subject names, else the sender's display name without its billing words, else the sender's domain.
function merchantOf(subject, from, rules) {
  for (const pattern of rules.subject_merchant) {
    const found = new RegExp(pattern, 'i').exec(subject);
    const name = found ? cleanName(found[1]) : '';
    if (name) return name;
  }
  const angle = /<([^>]*)>/.exec(from);
  const address = angle ? angle[1] : from;
  const shown = angle ? from.slice(0, angle.index) : (address.includes('@') ? '' : from);
  const named = cleanName(rules.name_drop.reduce((text, word) => text.replace(wordPattern(word), ' '), shown));
  if (named) return named;
  const domain = address.includes('@') ? address.split('@').pop().trim().toLowerCase() : '';
  return domain ? domain.split('.')[0] : null;
}

// What was bought: the subject without the merchant and the receipt words, or null.
function planOf(subject, merchant, rules) {
  const without = merchant ? subject.replace(new RegExp(escape(merchant), 'gi'), ' ') : subject;
  const plan = rules.plan_drop.reduce((text, word) => text.replace(wordPattern(word), ' '), without).replace(/#\S*/g, ' ');
  return cleanName(plan) || null;
}
