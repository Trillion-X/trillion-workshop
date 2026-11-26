import { realpathSync } from 'node:fs';
// tools/send-messages/do-work/mail-sender.mjs
//
// Purpose
//   The one way the person's account sends an email: every email row's run (tool:send-an-email
//   (any provider row)), and through them the sign-in codes its door sends. Who it comes from, how many
//   may go and how each provider's refusals read are one DATA row, the account's own `mail-settings` record
//   `settings:mail`, handed in by the caller as `mail_settings` (with none, the shipped row of read-data/mail-settings.json,
//   which names no sender, so nothing is sent), read here and nowhere else. Nothing is kept here: the caller's AI reads
//   the rows the limits count (the `mail-sent` rows and the day's `mail-day` row) from the person's store and hands
//   them in as `mail_sent` and `mail_day`; the answer's `keep` holds the rows as the send left them. Every email
//   is drawn here (read-data/draw-an-email.mjs) in the person's look, with the account's mark (`site`, `made_with`).
//
// Non-negotiable invariants
//   1. The sender comes only from the mail row (the one `from`, or for a written email the
//      sending account's own row of `senders.rows`); a caller may add only its own `reply_to`.
//   2. Never throws: → { sent: true, id } or { sent: false, error } in words a screen can show.
//   3. Every message carries its plain text and its drawn html. A caller gives the email part's fields (markdown,
//      preheader, action, footer_lines, footer_links) or plain `text`, which is drawn as its words. An email whose look
//      cannot be read is not sent (draw-an-email.mjs BRAND_UNREAD), never drawn in other colours.
//   4. A written email (sendWrittenEmail) also goes, as a BCC, to whoever the mail row's
//      `written_email_copies` names (the sending account's own address), never twice to the same person, and answers
//      with `sent_copy`: exactly what the binding was given.
//   5. Every email to one address is written down under it (the mail row's `sent_log`, the `mail-sent` rows answered in `keep`), and
//      one that would go over a `per_person` limit for its kind is not sent: → { sent: false, limited: true, error }.
//   6. A proof account's own address (the mail row's `proof_names`) is never handed to the sending binding, so live
//      proofs never spend the account's daily sending quota: it is written down as kept for the proof
//      (`held_for_proofs`).
//   7. Every email the binding takes counts toward the day (the mail row's `daily`, the `mail-day` row answered in `keep`); once only
//      `keep_back` of the day's `most` remain, only the kinds in `kept_for` (sign-in codes) still go: → { sent: false,
//      limited: true, error }. The binding refusing for its own daily quota fills the day, so nothing else knocks on it
//      until tomorrow.
//   8. Only a code in the provider's `refused_before_dispatch_codes` gives the allowance back; a binding that throws
//      with any other code, or none, may have sent it, so it answers unknown: true and is not sent again blindly.
//
// USAGE
//   node mail-sender.mjs [provider id]    the provider is the request's `provider` unless an id is given; the request on standard input (with the
//                                         person's saved look values in `saved`, read only) and the provider's keys on descriptor 4 on; the last line is { result: the answer }
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { rowsHandedIn } from '../read-data/rows-handed-in.mjs';
import { MessageRejectedError } from '../read-data/check-message-headers.ts';
import { currentPalette, drawEmail } from '../read-data/draw-an-email.mjs';
import { wornLookReader } from './read-the-worn-email-look.mjs';
import { heldKeys, providerOf, sendMessage } from './send-a-message.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SHIPPED = JSON.parse(readFileSync(join(here, '..', 'read-data', 'mail-settings.json'), 'utf8')).settings;
// The code of a send the sending seam refused before any provider was asked (a request it could not send).
export const REJECTED = 'rejected-before-sending';

// Admission before the mail binding is called. Pending and unknown deliveries keep their allowance;
// only a documented refusal releases it. Policy remains in mail-settings DATA, shared by every sending route.
// The admissions are rows handed in by the caller, worked in memory (read-data/rows-handed-in.mjs): one `mail-sent` row
// per recipient (its admissions within the sent log's days) and one `mail-day` row per UTC day (the allowance it has
// used). A reservation is one change of both, each conditioned on the row as it was read (`expected`); the run's `keep`
// answers them with the same `expected`, so two sends at once cannot both take the last slot: the caller's write of the
// one that loses is refused and that send reads again.

const SENT = 'mail-sent';
const DAY = 'mail-day';
const TRIES = 8;

const covers = (limit, kind) => limit.kinds ? limit.kinds.includes(kind) : !(limit.all_kinds_except ?? []).includes(kind);
const conflict = error => error?.code === 'original_command_conflict';
// A row one write keeps, conditioned on the record as it was read (null: none yet).
const kept = (type, id, value, read) => ({ id, type, value, expected: read ? { type, value: read.value } : null });

/** The admission owner of one account: `door` the rows handed in, `settings` its mail row, `dayKey` the row id of the
 * UTC day a time falls in. Recipients are named by their `mail-sent` row ids. */
function mailAdmission(door, settings, dayKey) {
  const held = new Map();

  async function reserveMail({ id, recipients, kind, subject, proof, now }) {
    for (let tries = 0; tries < TRIES; tries += 1) {
      const day = new Date(now).toISOString().slice(0, 10);
      const writes = [];
      for (const recipient of recipients) {
        const read = await door.readRecord(SENT, recipient);
        // Bounded retirement only: what is past the sent log's days leaves with this write.
        const rows = (read?.value?.admissions ?? []).filter(row => row.at_ms > now - settings.sent_log.days * 86400000);
        const over = settings.per_person.limits.find(limit => {
          if (!covers(limit, kind)) return false;
          const count = rows.filter(row => row.state !== 'released' && covers(limit, row.kind) && row.at_ms > now - limit.window_minutes * 60000).length;
          return count >= limit.most;
        });
        if (over) return { allowed: false, error: over.says };
        rows.push({ id, day, at_ms: now, kind, proof: Boolean(proof), state: 'reserved',
          subject: settings.sent_log.subject_kept_out_for.includes(kind) ? null : subject ?? null });
        writes.push(kept(SENT, recipient, { admissions: rows }, read));
      }
      const read = proof ? null : await door.readRecord(DAY, dayKey(now));
      const used = proof ? 0 : read?.value?.used ?? 0;
      const cap = settings.daily.most - (settings.daily.kept_for.includes(kind) ? 0 : settings.daily.keep_back);
      if (!proof && used >= cap) return { allowed: false, error: settings.daily.says };
      if (!proof) writes.push(kept(DAY, dayKey(now), { used: used + 1 }, read));
      try {
        await door.write(writes);
        held.set(id, { recipients, at: now, proof: Boolean(proof) });
        return { allowed: true, id };
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new Error('The email allowance kept changing while it was being taken.');
  }

  async function settleMail(id, state, providerFull = false) {
    if (!['sent', 'unknown', 'released'].includes(state)) throw new Error('The email result is invalid.');
    const row = held.get(id);
    if (!row) return;
    for (let tries = 0; tries < TRIES; tries += 1) {
      const writes = [];
      let settled = false;
      for (const recipient of row.recipients) {
        const read = await door.readRecord(SENT, recipient);
        // A copy: the record as read is the condition of the write.
        const rows = structuredClone(read?.value?.admissions ?? []);
        const one = rows.find(admission => admission.id === id);
        if (!one || one.state !== 'reserved') continue;
        one.state = state;
        settled = true;
        writes.push(kept(SENT, recipient, { admissions: rows }, read));
      }
      if (!row.proof && (providerFull || (settled && state === 'released'))) {
        const read = await door.readRecord(DAY, dayKey(row.at));
        const used = read?.value?.used ?? 0;
        writes.push(kept(DAY, dayKey(row.at), { used: providerFull ? Math.max(used, settings.daily.most) : Math.max(0, used - 1) }, read));
      }
      try {
        if (writes.length) await door.write(writes);
        held.delete(id);
        return;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new Error('The email result kept changing while it was being kept.');
  }

  async function mailSentTo(recipient, now) {
    const read = await door.readRecord(SENT, recipient);
    const rows = [];
    for (const row of read?.value?.admissions ?? []) {
      if (row.at_ms > now - settings.sent_log.days * 86400000 && row.state === 'sent') rows.push({ at: new Date(row.at_ms).toISOString(), kind: row.kind,
        ...(row.subject === null ? {} : { subject: row.subject }) });
    }
    return rows.sort((a, b) => a.at.localeCompare(b.at));
  }

  return { reserveMail, settleMail, mailSentTo };
}

/** The account's mail row: the shipped row (which names no sender) with the fields the caller handed in (`mail_settings`,
 * read from the account's own sender row) over it. */
export function mailSettings(handedIn, shipped = SHIPPED) {
  if (handedIn === undefined || handedIn === null) return shipped;
  if (typeof handedIn !== 'object' || Array.isArray(handedIn)) throw new Error('mail_settings is the account\'s mail row, read from the person\'s store.');
  return { ...shipped, ...handedIn };
}

/** The provider's sending binding: one composed email through the sending seam, answering the provider's message id,
 * or throwing with the provider's own code (read by its mail row's `error_code`). */
export function bindingFor(provider, credentials, row, options = {}) {
  const rules = row.providers?.[provider.id] ?? {};
  const codeOf = said => (rules.error_code ? new RegExp(rules.error_code).exec(said)?.groups?.code : undefined);
  return {
    async send(composed) {
      let answer;
      try {
        answer = await sendMessage({
          to: composed.to, from: `${composed.from.name} <${composed.from.email}>`, subject: composed.subject,
          ...Object.fromEntries(['text', 'markdown', 'html', 'headers', 'bcc', 'template', 'variables', 'message', 'idempotencyKey']
            .filter(field => composed[field] !== undefined && composed[field] !== null).map(field => [field, composed[field]])),
          ...(composed.replyTo ? { reply_to: composed.replyTo } : {}),
        }, { providerId: provider.id, credentials, ...options });
      } catch (error) {
        if (error instanceof MessageRejectedError) throw Object.assign(new Error(error.message), { code: REJECTED });
        throw error;
      }
      const [first] = answer.sent;
      if (first?.error) throw Object.assign(new Error(first.error), { code: codeOf(first.error) });
      return { messageId: first?.messageId ?? null };
    },
  };
}

/**
 * The mail rules over one account: `row` its mail row, `door` the rows handed in (rowsHandedIn), `binding` the provider's sending
 * binding (bindingFor), `provider` the provider row's id, whose refusals the mail row lists under `providers`,
 * `readLook` the reader of the look its emails wear (draw-an-email.mjs currentPalette: none, the shipped look).
 */
export function mailSender({ row, door, binding, provider, readLook }) {
  const rules = row.providers?.[provider] ?? {};
  const settings = {
    ...row, send_binding: 'provider',
    refused_before_dispatch_codes: { codes: [REJECTED, ...(rules.refused_before_dispatch_codes ?? [])], suppression_codes: rules.suppression_codes ?? [] },
    daily: { ...row.daily, provider_full_code: rules.provider_full_code ?? null },
  };
  const env = { POOL: door, [settings.send_binding]: binding };

  // Every email to one address is written down under that address (`sent_log.key_prefix` + the BLAKE3 identity of
  // the lowercased address): when, what kind, and its subject unless its kind keeps the subject out (a sign-in code's
  // subject carries the code). The rows of `per_person.limits` are counted against that list. Reading the list back is
  // how every email one person was sent is listed.
  const blake3Hex = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice('1f:'.length);
  const sentKey = to => `${settings.sent_log.key_prefix}${blake3Hex(String(to).trim().toLowerCase())}`;
  const limitCovers = (limit, kind) => (limit.kinds ? limit.kinds.includes(kind) : !(limit.all_kinds_except ?? []).includes(kind));
  // How many emails the binding has taken today (UTC), kept under `daily.key_prefix` + the day.
  const dayKey = now => `${settings.daily.key_prefix}${new Date(now).toISOString().slice(0, 10)}`;
  const pool = mailAdmission(door, settings, dayKey);
  const mailPool = env => env?.POOL ? pool : null;

  /** The emails sent to `to` within the log's days, oldest first: [{ at, kind, subject? }]. */
  async function sentTo(env, to, now = Date.now()) {
    return env?.POOL ? mailPool(env).mailSentTo(sentKey(to), now) : [];
  }

  /** The `per_person` limit a send of `kind` to someone already sent `sent` would go over, or null. */
  function limitReached(sent, kind, now = Date.now()) {
    return settings.per_person.limits.find(limit => limitCovers(limit, kind)
      && sent.filter(row => limitCovers(limit, row.kind) && now - Date.parse(row.at) < limit.window_minutes * 60_000).length >= limit.most) ?? null;
  }

  // A proof account's own address: every recipient matches a pattern of the mail row's `proof_names`.
  const proofNames = settings.proof_names;
  const PROOF_NAMES = proofNames.patterns.map(pattern => new RegExp(pattern, 'i'));
  const addressOf = to => String(typeof to === 'object' && to !== null ? to.email ?? '' : to).trim().toLowerCase();
  const isProofAddress = to => [to].flat().length > 0 && [to].flat().every(each => PROOF_NAMES.some(pattern => pattern.test(addressOf(each))));

  // A proof's mail, never handed to the sending binding: it is written down as kept for the proof.
  async function keepForProof(env, composed) {
    return { sent: true, id: null, kept_for_proof: settings.held_for_proofs.not_kept };
  }

  // The records owner reserves recipient and day limits together, before any delivery.
  // A refused admission or unreachable owner cannot fall through to dispatch.
  async function admittedDelivery(env, binding, composed, kind, now) {
    const proof = isProofAddress(composed.to);
    const addresses = [...new Set([composed.to].flat().map(addressOf))];
    const recipients = addresses.map(sentKey);
    let pool, admission;
    try {
      pool = mailPool(env);
      admission = await pool.reserveMail({ id: crypto.randomUUID(), recipients, kind, subject: composed.subject, proof, now });
    } catch (error) {
      console.error('email allowance unavailable:', error?.message ?? '');
      return { sent: false, error: 'Email could not be sent while its sending limit is unavailable. Try again shortly.' };
    }
    if (!admission.allowed) return { sent: false, limited: true, error: admission.error };
    const settle = async (state, full = false) => {
      try { await pool.settleMail(admission.id, state, full); }
      catch (error) { console.error('email result could not be kept; its allowance remains held:', error?.message ?? ''); }
    };
    let result;
    try { result = proof ? await keepForProof(env, composed) : await binding.send(composed); }
    catch (error) {
      const refused = !proof && settings.refused_before_dispatch_codes.codes.includes(error.code);
      await settle(refused ? 'released' : 'unknown', error.code === settings.daily.provider_full_code);
      return { sent: false, ...(!refused ? { unknown: true } : {}), ...(settings.refused_before_dispatch_codes.suppression_codes.includes(error.code) ? { suppressed: true } : {}), error: `${error.code ?? 'send-failed'}: ${error.message ?? ''}`.slice(0, 200) };
    }
    await settle('sent');
    return proof ? result : { sent: true, id: result?.messageId ?? null };
  }

  // Hands one composed message to the sending binding: { sent: true, id }, { sent: false, error }, { sent: false,
  // limited: true, error } when it would go over a per-person limit for its `kind` or over the day's share for kinds the
  // day does not keep room for, or
  // { sent: false, unknown: true, error } when the binding threw with a code not in refused_before_dispatch_codes (it may
  // have sent). A proof's own address is answered { sent: true, id: null, kept_for_proof } without the binding.
  async function deliver(env, composed, kind = settings.per_person.default_kind) {
    const binding = env?.[settings.send_binding];
    if (!binding?.send) return { sent: false, error: `no email-sending binding is bound as ${settings.send_binding}` };
    if (!settings.from?.email || !settings.from?.name) return { sent: false, error: settings.no_sender };
    const now = Date.now();
    if (env?.POOL) return admittedDelivery(env, binding, composed, kind, now);
    return { sent: false, error: 'Email could not be sent while its sending limit is unavailable. Try again shortly.' };
  }

  /** The message the binding is given, exactly: { from, to, bcc?, replyTo?, subject, text, html, headers? }, its words
   * drawn in `palette` with the account's mark; a caller's own html, or a template the sending seam fills, goes as it
   * is. mail: the sending row's own choices, { reply_to?, sender_name? }, or nothing. */
  function composeMail(mail, { to, subject, bcc = null, text = null, markdown = null, headers = null, reply_to: askedReplyTo = null, ...shown }, palette) {
    const own = Boolean(shown.html || shown.template);
    // The caller's own reply_to (invariant 1) is the one a send gives when the sending row names none. Before Nov 26 2026 a plain
    // send's reply_to stayed in the message as a field no binding reads, so a site newsletter's confirm mail went with no Reply-To.
    const replyTo = mail?.reply_to ?? replyToOf(askedReplyTo);
    const { preheader, action, footer_lines, footer_links, mark, people, ...kept } = shown;
    const drawn = own ? null : drawEmail({ preheader, action, footer_lines, footer_links, mark, people, markdown: markdown ?? text }, settings.site ?? null, palette, settings.made_with ?? null);
    return {
      from: mail?.sender_name ? { email: settings.from.email, name: mail.sender_name } : mail?.from ?? settings.from, to, ...(bcc?.length ? { bcc } : {}), ...(replyTo ? { replyTo } : {}), subject,
      ...(own ? { ...kept, ...(text ? { text } : {}) } : { ...kept, text: drawn.text, html: drawn.html }),
      ...(headers ? { headers } : {}),
    };
  }

  /**
   * mail:    the sending row's own choices, { reply_to?, sender_name? }, or nothing
   * message: as composeMail takes it, plus `kind`, which names it for the per-person limits (`per_person.default_kind`
   *          when not given)
   */
  async function sendMail(env, mail, { kind = settings.per_person.default_kind, ...message }) {
    // Ordinary message DATA cannot choose the sending identity or binding. The
    // written-email owner selects its own declared sender directly below.
    const { from: ignoredFrom, send_binding: ignoredBinding, ...row } = mail ?? {};
    const { from: ignoredMessageFrom, ...words } = message;
    const look = await currentPalette(readLook);
    if (look.error) return { sent: false, error: look.error };
    let composed;
    try {
      composed = composeMail(mail ? row : null, words, look.palette);
    } catch (error) {
      return { sent: false, error: error.message };
    }
    const sent = await deliver(env, composed, kind);
    return sent;
  }

  /** The sender of a written email sent for `owner` (the sending account's own address): that address's row of
   * the mail row's `senders.rows`, else the one `from` every other email comes from. */
  const senderFor = owner => {
    const key = typeof owner === 'string' ? owner.trim().toLowerCase() : '';
    return settings.senders.rows.find(row => row.owner.toLowerCase() === key)?.from ?? settings.from;
  };

  const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

  /** A caller's reply_to as the binding takes it: one address, trimmed, or none; anything else is refused in words. */
  const replyToOf = given => {
    if (given === null || given === undefined || given === '') return null;
    if (typeof given !== 'string' || !EMAIL_SHAPE.test(given.trim())) throw new Error(`${given} is not an email address to reply to.`);
    return given.trim();
  };

  // Who gets a copy of every written email, from the mail row's `written_email_copies`: `account_owner` is the
  // sending account's own address (`owner`, the mail row's own), left out when the email already goes to it.
  const writtenCopies = (address, owner) => (settings.written_email_copies === 'account_owner' && typeof owner === 'string' && EMAIL_SHAPE.test(owner.trim()) && owner.trim().toLowerCase() !== address.toLowerCase() ? [owner.trim()] : []);

  /** Subscription mail uses the same sender, drawing and allowance owner as personal mail. */
  function subscriptionMail(subscription, sender) {
    if (subscription === null || subscription === undefined) return {};
    if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)
        || Object.keys(subscription).some(key => !['unsubscribe_url', 'list_id', 'reason', 'unsubscribe_label'].includes(key)))
      throw new Error('Subscription mail needs its unsubscribe URL, list identity and reason.');
    let url;
    try { url = new URL(subscription.unsubscribe_url); } catch { throw new Error('Subscription mail needs an HTTPS one-click unsubscribe URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\r\n]/.test(subscription.unsubscribe_url))
      throw new Error('Subscription mail needs an HTTPS one-click unsubscribe URL.');
    if (typeof subscription.list_id !== 'string' || !/^[^<>\r\n]{0,100}<[a-z0-9][a-z0-9.-]{0,190}\.[a-z]{2,}>$/i.test(subscription.list_id))
      throw new Error('Subscription mail needs its List-ID with a domain in angle brackets.');
    if (typeof subscription.reason !== 'string' || !subscription.reason.trim() || subscription.reason.length > 1000)
      throw new Error('Subscription mail needs the actual reason this person receives it.');
    if (typeof settings.postal_address !== 'string' || !settings.postal_address.trim()) throw new Error('Subscription mail needs the sending owner’s postal address.');
    const label = subscription.unsubscribe_label ?? settings.subscription.unsubscribe_label;
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('Subscription mail needs its unsubscribe label.');
    return {
      headers: { 'List-Unsubscribe': `<${url.href}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-ID': subscription.list_id },
      footer_lines: [subscription.reason.trim(), `${sender.name}, ${settings.postal_address.trim()}`],
      footer_links: [{ label: label.trim(), href: url.href }],
    };
  }

  /**
   * One written email from the account's own sender: { to, subject, markdown, preheader?, action?: { label, href },
   * reply_to? } → { sent, id, said, sent_copy? }. `owner` is the sending account's own address; it gets a BCC copy
   * (`written_email_copies`), so every email lands in the owner's own mail too. `sent_copy`, present when it went out,
   * is exactly what the binding was given: { to, from, reply_to, bcc, subject, preheader, markdown,
   * sent_at, provider }. Refuses, in words a person reads, an address that is not one or a message with no words.
   */
  /** One written email as the binding would be given it: validated, its words drawn, its BCC copy and subscription
   * headers set. Sends nothing. → { composed, subscribed, address } or { error } when the look cannot be read. */
  async function composeWritten({ to, subject, markdown, preheader = null, action = null, reply_to: replyTo = null, subscription = null, idempotencyKey = null }, owner) {
    const address = typeof to === 'string' ? to.trim() : '';
    if (!EMAIL_SHAPE.test(address)) throw new Error(`${to} is not an email address.`);
    if (typeof subject !== 'string' || !subject.trim()) throw new Error('An email needs a subject.');
    if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('An email needs its words, in markdown.');
    if (replyTo !== null && !EMAIL_SHAPE.test(String(replyTo).trim())) throw new Error(`${replyTo} is not an email address to reply to.`);
    const bcc = writtenCopies(address, owner);
    const sender = senderFor(owner), subscribed = subscriptionMail(subscription, sender);
    const look = await currentPalette(readLook);
    if (look.error) return { address, error: look.error };
    const composed = composeMail({ from: sender, ...(replyTo ? { reply_to: String(replyTo).trim() } : {}) }, {
      to: address, subject: subject.trim(), markdown, bcc, ...subscribed, ...(preheader ? { preheader } : {}), ...(action?.href && action?.label ? { action } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }, look.palette);
    return { address, composed, subscribed };
  }

  async function sendWrittenEmail(env, message, { owner = settings.owner ?? null, now = () => new Date() } = {}) {
    const { address, composed, subscribed, error } = await composeWritten(message, owner);
    if (error) return { sent: false, error, said: `The email to ${address} did not go out: ${error}` };
    const result = await deliver(env, composed);
    if (!result.sent) return { ...result, said: `The email to ${address} did not go out: ${result.error}` };
    const sent_copy = {
      to: [composed.to], from: `${composed.from.name} <${composed.from.email}>`, reply_to: composed.replyTo ?? null, bcc: composed.bcc ?? [],
      subject: composed.subject, preheader: message.preheader ?? null, markdown: message.markdown,
      ...(message.subscription ? { headers: composed.headers, footer_lines: subscribed.footer_lines, footer_links: subscribed.footer_links } : {}),
      sent_at: now().toISOString(), provider,
    };
    return { ...result, said: `Emailed ${address} from ${composed.from.email}.`, sent_copy };
  }

  /** The written email exactly as sendWrittenEmail would give the binding, and nothing sent: no allowance is taken and
   * the provider is not asked. → { sent: false, dry_run: true, composed } or { sent: false, error }. */
  async function previewWrittenEmail(message, { owner = settings.owner ?? null } = {}) {
    const sender = senderFor(owner);
    if (!sender?.email || !sender?.name) return { sent: false, dry_run: true, error: settings.no_sender };
    const { address, composed, error } = await composeWritten(message, owner);
    if (error) return { sent: false, dry_run: true, error, said: `The email to ${address} would not go out: ${error}` };
    return {
      sent: false, dry_run: true,
      composed: {
        from: `${composed.from.name} <${composed.from.email}>`, reply_to: composed.replyTo ?? null, to: composed.to, bcc: composed.bcc ?? [],
        subject: composed.subject, text: composed.text, html: composed.html ?? null, ...(composed.headers ? { headers: composed.headers } : {}),
      },
      said: `Would email ${address} from ${composed.from.email}. Nothing was sent.`,
    };
  }

  return {
    sendMail: (mail, message) => sendMail(env, mail, message),
    sendWrittenEmail: (message, options) => sendWrittenEmail(env, message, options),
    previewWrittenEmail,
    sentTo: (to, now) => sentTo(env, to, now),
    limitReached, isProofAddress, senderFor,
  };
}

/** One request of an email row, each recipient on its own, answered in the sending seam's shape: { provider, sent:
 * [{ recipient, messageId?, kept_for_proof?, sent_copy?, error?, limited?, unknown?, suppressed? }], said }. A request
 * with `markdown` is a written email (its BCC copy and sent copy); any other goes as its `kind` (a sign-in code names
 * its own). */
export async function sendAnEmail(request, { provider, sender }) {
  const recipients = Array.isArray(request.recipients) ? request.recipients : [request.to];
  const sent = [];
  for (const recipient of recipients) {
    const { recipients: _all, dry_run: _dry, ...one } = { ...request, to: recipient };
    let result;
    try {
      if (request.dry_run) result = typeof one.markdown === 'string' ? await sender.previewWrittenEmail(one) : { sent: false, error: 'A dry run takes written email, its words in markdown.' };
      else result = typeof one.markdown === 'string' ? await sender.sendWrittenEmail(one) : await sender.sendMail(null, one);
    } catch (error) {
      result = { sent: false, error: error.message };
    }
    if (request.dry_run) {
      sent.push(result.composed ? { recipient, composed: result.composed } : { recipient, error: result.error });
      continue;
    }
    sent.push(result.sent
      ? { recipient, messageId: result.id, ...(result.kept_for_proof ? { kept_for_proof: result.kept_for_proof } : {}), ...(result.sent_copy ? { sent_copy: result.sent_copy } : {}) }
      : { recipient, error: result.error, ...Object.fromEntries(['limited', 'unknown', 'suppressed'].filter(flag => result[flag]).map(flag => [flag, true])) });
  }
  const failed = sent.filter(item => item.error);
  if (request.dry_run) return { provider, dry_run: true, sent, said: `Would send ${sent.length - failed.length} of ${sent.length} through ${provider}. Nothing was sent.` };
  const said = `Sent to ${sent.length - failed.length} of ${sent.length} through ${provider}.${failed.length ? ` Not sent: ${failed.map(item => `${item.recipient} (${item.error})`).join('; ')}` : ''}`;
  return { provider, sent, said };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const { saved, mail_settings: handedSettings, mail_sent: sentRows = [], mail_day: dayRows = [], ...request } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const row = mailSettings(handedSettings);
    const provider = providerOf(process.argv[2] ?? request.provider);
    if (provider.channel !== 'email') throw new Error(`${provider.id} is not an email provider.`);
    const rows = rowsHandedIn([...sentRows, ...dayRows]);
    // A dry run composes the message and never reaches the provider, so it reads no key.
    const binding = request.dry_run ? null : bindingFor(provider, heldKeys(provider), row);
    const sender = mailSender({ row, door: rows, binding, provider: provider.id, readLook: wornLookReader(saved) });
    console.log(JSON.stringify({ result: { ...await sendAnEmail(request, { provider: provider.id, sender }), keep: rows.keep() } }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
