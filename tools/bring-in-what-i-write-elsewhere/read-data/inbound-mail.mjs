// src/inbound-mail.mjs
//
// The email carrier for the one door (src/inbound.mjs): each account has its own address at the inbound mail domain,
// and whatever reaches it is kept and handed to that account's AIs.
//
// Purpose
//   A person can write to their AIs from any mail app, on any device, even when every AI app is closed. Cloudflare
//   Email Routing delivers mail for the whole inbound domain to this Worker's email handler (receiveMail); the part
//   before the @ names the account. The account's own address and its list of senders who speak for the person are
//   read and set with addressRequest (/mcp/api/inbound/address).
//
// Non-negotiable invariants
//   1. The address is random and names nothing about the person; an unknown address is refused at the SMTP step.
//   2. Mail counts as the person's own words only when its From is on their list AND the mail passed DMARC as
//      recorded by the receiving server; anything else is handed on as information (from_person: false), so a forged
//      From cannot direct the person's AIs.
//   3. The domain, the route's name, the folder attachments are kept in and the limits are DATA
//      (inbound-mail-settings.json). Mail for a `handed_on` domain is not an account's: it is handed whole to the
//      Worker that domain's row names (the proof inbox), so every address there is kept.
//   5. An address this Worker would refuse is known before anything is sent to it (src/inbound-mail-addresses.mjs
//      refusalOf), so a send never reports as sent what the receiving side here turns away.
//   4. The account's kept-plan gate is checked before mail is parsed or any attachment is kept. After that, every
//      attachment is kept in Files before its arrival is taken, under the content identity the arrival names it by.
//      A refused arrival leaves those files available in Files and names them in the bounce; nothing is deleted.
//   6. Mail is never bounced because the account's store could not answer (it was resetting, busy or out of memory): the
//      arrival and its attachments wait at the edge (src/share-inbox.mjs) and reach /inbound when the store answers. Only a
//      refusal for good (a plan that keeps nothing) bounces.
//
// Security
//   The address is a capability to put words in front of the person's AIs as information, never as instructions,
//   unless invariant 2 holds. It is turned over by asking for a new one (rotate: true), which retires the old one.
//
import settings from '../../send-notes-in-by-mail/src/inbound-mail-settings.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { GENERIC_TYPE, fileType } from '../../organize-my-files/src/file-type.mjs';
import { handedOnFor, tokenKey } from '../../send-notes-in-by-mail/src/inbound-mail-addresses.mjs';
import { INBOUND_PATH } from './inbound-own-records.mjs';

// The hosted email carrier needs its admitted address store, namespace writer,
// durable edge-outage keeper and MIME parser. They are supplied by the host,
// not imported from the retired Worker engine or simulated by records writes.
export function createInboundMail({ keepStream, deliverSiteWorkerEmail, ShareInboxError, keepInEdge, storeDown, PostalMime }) {
  if ([keepStream, deliverSiteWorkerEmail, ShareInboxError, keepInEdge, storeDown].some(value => typeof value !== 'function') || typeof PostalMime?.parse !== 'function')
    throw Object.assign(new Error('The hosted mail parser, Files writer and durable edge owner are unavailable.'), { code: 'inbound_mail_host_unavailable', status: 503 });
const ownerKey = userId => `inbound-address-of:${userId}`;
const newToken = () => [...crypto.getRandomValues(new Uint8Array(settings.address_bytes))].map(byte => byte.toString(36).padStart(2, '0')).join('').slice(0, settings.address_bytes * 2);
const clean = value => String(value ?? '').trim().toLowerCase();

// GET: the account's address and senders (made on first ask). POST { senders?, rotate? }: change them.
async function addressRequest(request, env, userId) {
  let held = await env.APP_KV.get(ownerKey(userId), 'json');
  const asked = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  if (asked.senders !== undefined) {
    if (!Array.isArray(asked.senders) || asked.senders.length > settings.max_senders || asked.senders.some(sender => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(sender)))) {
      return Response.json({ error: `senders is a list of up to ${settings.max_senders} email addresses that speak for you.` }, { status: 400 });
    }
  }
  if (!held || asked.rotate === true) {
    if (held) await env.APP_KV.delete(tokenKey(held.token));
    held = { token: newToken(), senders: held?.senders ?? [] };
    await env.APP_KV.put(tokenKey(held.token), JSON.stringify({ userId }));
  }
  if (asked.senders !== undefined) held = { ...held, senders: [...new Set(asked.senders.map(clean))] };
  await env.APP_KV.put(ownerKey(userId), JSON.stringify(held));
  return Response.json({ address: `${held.token}@${settings.domain}`, senders: held.senders });
}

// The account's own address, made on first ask: the same answer GET /mcp/api/inbound/address gives, for the screens
// that show it to the person (src/account-routes.mjs).
async function inboundAddress(env, userId) {
  return (await (await addressRequest(new Request('https://person/inbound/address'), env, userId)).json()).address;
}

// Whether the receiving server recorded a DMARC pass for this mail (the Authentication-Results it added).
const dmarcPassed = headers => headers.filter(header => header.key === 'authentication-results').some(header => /\bdmarc=pass\b/i.test(header.value));

// A name segment taken from the mail: no slashes or control characters, so it can never open another folder.
const segment = (value, fallback) => String(value ?? '').replace(/[\\/\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, settings.name_max) || fallback;
// An attachment's type: what the mail says, unless it says only "some bytes" (many senders label a voice memo
// application/octet-stream); then the type its name gives (src/file-type.mjs, the rule every upload road shares).
const typeOf = (said, name) => fileType(said, name) ?? GENERIC_TYPE;

// Cloudflare's email handler: message { from, to, raw, headers, setReject }, inboundFor(userId) -> { fetch } of the
// account's POST /inbound (the Worker gives its own records, src/inbound-own-records.mjs),
// keep(userId, { name, size, open, media_type, identity }): the namespace write every uploaded file takes.
async function receiveMail(message, env, inboundFor, keep = (userId, file) => keepStream(env, userId, file), ctx = null) {
  const handedOn = handedOnFor(message.to);
  if (handedOn) {
    const raw = await new Response(message.raw).text();
    const mail = { from: message.from, to: message.to, subject: message.headers?.get?.('subject') ?? '',
      headers: [...(message.headers?.entries?.() ?? [])], raw };
    if (handedOn.site_backend_installation_id &&
        await deliverSiteWorkerEmail(env, ctx, handedOn.site_backend_installation_id, mail)) return;
    const keeper = env?.[handedOn.binding];
    if (!keeper?.keep) return message.setReject('This inbox cannot take mail just now.');
    await keeper.keep(mail);
    return;
  }
  const token = clean(message.to).split('@')[0];
  const owner = token ? await env.APP_KV.get(tokenKey(token), 'json') : null;
  if (!owner) return message.setReject('No such address.');
  const held = await env.APP_KV.get(ownerKey(owner.userId), 'json');
  const inbox = inboundFor(owner.userId);
  let waitForStore = false;
  if (typeof inbox?.preflight === 'function') {
    try {
      const preflight = await inbox.preflight();
      if (!preflight || !Number.isInteger(preflight.status)) throw Object.assign(new Error('The account could not check whether it can keep mail.'), { reply_status: 503 });
      if (preflight.status >= 500 || preflight.status === 408 || preflight.status === 429) waitForStore = true;
      else if (!preflight.ok) return message.setReject((await preflight.json().catch(() => ({}))).error ?? 'Could not be kept.');
    } catch (error) {
      if (!storeDown(error)) throw error;
      waitForStore = true;
    }
  } else waitForStore = true;
  // The mail parser is loaded only when mail arrives, never at a Worker's start.
  const mail = await PostalMime.parse(message.raw);
  const from = clean(mail.from?.address ?? message.from);
  const fromPerson = (held?.senders ?? []).includes(from) && dmarcPassed(mail.headers ?? []);
  const at = mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : new Date().toISOString();
  // Each mail's attachments go in a folder of their own, named by the day and the subject (or sender), so two memos
  // both called "New Recording.m4a" never take each other's name.
  const folder = `${settings.files_folder}/${at.slice(0, 10)} ${segment(mail.subject, segment(from, 'mail'))}`;
  // Each attachment is named by its content identity (the one the namespace gives it), known before anything is kept.
  const files = (mail.attachments ?? []).map(file => new Uint8Array(file.content ?? new ArrayBuffer(0))).map((bytes, index) => ({ bytes, file: mail.attachments[index] }))
    .filter(({ bytes }) => bytes.byteLength)
    .map(({ bytes, file }, index) => ({ bytes, file, name: segment(file.filename, `attachment-${index + 1}`) }))
    .map(({ bytes, file, name }) => ({ bytes, name, id: makeHashCodeHexFromBytes(bytes), media_type: typeOf(file.mimeType, name) }));
  const attached = files.map(file => `${file.name} (${file.media_type}, ${file.bytes.byteLength} bytes), in Files at ${folder}`);
  const text = [mail.text?.trim() || (mail.html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), attached.length ? `Attached: ${attached.join('; ')}` : ''].filter(Boolean).join('\n\n');
  const arrival = { route: settings.route, source_id: mail.messageId ?? `${from}:${at}`, text: text || '(no words)', at, from, from_person: fromPerson,
    ...(mail.subject ? { title: mail.subject } : {}), ...(files.length ? { files: files.map(({ id, name }) => ({ id, name })) } : {}) };
  // A store that cannot answer now (resetting, busy, out of memory) does not bounce the mail: the arrival and its
  // attachments are kept at the edge and sent to /inbound when the store answers (src/share-inbox.mjs). The arrival is
  // the same arrival when replayed, so nothing is done twice.
  const keepForLater = async () => {
    const bytesText = bytes => { let text = ''; for (let at = 0; at < bytes.byteLength; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return btoa(text); };
    try {
      await keepInEdge(env, owner.userId, { key: `mail-${arrival.source_id}`, kind: 'inbound', path: INBOUND_PATH, body: JSON.stringify(arrival),
        files: files.map(file => ({ name: `${folder}/${file.name}`, media_type: file.media_type, identity: file.id, base64: bytesText(file.bytes) })) });
    } catch (error) {
      if (!(error instanceof ShareInboxError)) throw error;
      message.setReject(error.message);
    }
  };
  // A temporary account outage keeps the complete message at the edge. A later replay repeats the kept-plan check
  // before it writes any attachment into Files.
  if (waitForStore) return keepForLater();
  try {
    for (const file of files) await keep(owner.userId, { name: `${folder}/${file.name}`, size: file.bytes.byteLength,
      open: async () => [file.bytes], media_type: file.media_type, identity: file.id });
  } catch (error) {
    console.error('inbound mail attachment not kept:', error?.message ?? error);
    return message.setReject('An attachment could not be kept just now. Send this email again in a minute.');
  }
  let answer;
  try { answer = await inbox.fetch(new Request(`https://person${INBOUND_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arrival) })); }
  catch (error) { if (!storeDown(error)) throw error; return keepForLater(); }
  if (answer.status >= 500) return keepForLater();
  // A refused take does not erase files already written: name their exact Files location so the person can recover them.
  if (!answer.ok) {
    const reason = (await answer.json().catch(() => ({}))).error ?? 'Could not be kept.';
    const keptFiles = files.length ? ` The attachments remain in your Files at ${folder}: ${files.map(file => file.name).join(', ')}.` : '';
    return message.setReject(`${reason}${keptFiles}`);
  }
}

  return { addressRequest, inboundAddress, receiveMail };
}
