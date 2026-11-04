// src/sms-inbound.mjs
//
// Purpose
//   The text-message address Twilio calls for each message that arrives at the AI's number (src/entry-points.json
//   `inbound`). It checks that Twilio sent it, reads the sender's number, and starts the conversation: a text from a
//   known account's verified phone is delivered to that person's AIs through the shared message owner; a text from a
//   number that started on a landing page (src/entry-points.mjs) is answered with that entry point's welcome and the
//   way to finish creating the account; any other number is not answered.
//
// Non-negotiable invariants
//   1. Nothing is acted on before the signature holds. Twilio signs the exact address it was given plus every field,
//      with the auth token (HMAC-SHA1, Twilio's own scheme); the token is read by its secret's name and never appears in
//      source, logs or answers. No token set answers 503 naming the secret, never an unchecked pass.
//   2. The sender's number is only compared as keyed digests (the contact key); it is never stored or logged here.
//   3. The same MessageSid is handled once: Twilio retries a slow answer, and a retry changes nothing.
//   4. A stranger's number gets an empty answer: the AI does not start talking to numbers nobody introduced.
//   5. Every word, limit and name is a row in src/entry-points.json.
import data from '../../../start-from-any-landing-page/src/entry-points.json' with { type: 'json' };
import { entryLeadForPhone, inboundWelcome } from '../../../start-from-any-landing-page/src/entry-points.mjs';
import { normalPhone } from '../../../start-from-any-landing-page/src/sign-in-phone.mjs';
import { secret } from '../../../start-from-any-landing-page/src/worker-secrets.mjs';

const inbound = data.inbound;
const encoder = new TextEncoder();

/** Twilio's request signature: base64 HMAC-SHA1 over the address followed by each field name and value, names sorted. */
export async function twilioSignature(url, params, token) {
  const signed = url + [...params.keys()].sort().map(name => name + params.getAll(name).join('')).join('');
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signed)))));
}

const sameText = (left, right) => left.length === right.length && [...left].reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ right.charCodeAt(index)), 0) === 0;
const escapeXml = text => String(text).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const twiml = message => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`, { headers: { 'content-type': 'text/xml; charset=utf-8' } });

/**
 * Answers one Twilio inbound message. Dependencies, all supplied by the caller:
 *   origin               this service's public origin
 *   read(key) / keep(key, value, ttl)   the key-value store (leads, seen message ids)
 *   ownerOf(phone)       the account whose verified phone this is, or null
 *   deliver(userId, { text, client_id })   hands the text to that person's AIs (the shared message owner)
 */
export async function handleInboundSms(request, env, { origin, read, keep, ownerOf, deliver }) {
  const token = secret(env, inbound.auth_token_secret);
  if (!token) return Response.json({ error: `Inbound text is not set up: the secret ${inbound.auth_token_secret} is missing.` }, { status: 503 });
  const raw = await request.text();
  if (raw.length > inbound.max_body_bytes) return Response.json({ error: 'Request too large' }, { status: 413 });
  const params = new URLSearchParams(raw);
  const given = request.headers.get('x-twilio-signature') ?? '';
  const url = env[inbound.url_override_env] || `${origin}${inbound.path}`;
  if (!sameText(given, await twilioSignature(url, params, token))) return Response.json({ error: 'Not from Twilio.' }, { status: 403 });
  const sid = params.get('MessageSid') ?? '';
  if (!/^[A-Za-z0-9]{10,64}$/.test(sid)) return Response.json({ error: 'No message id.' }, { status: 400 });
  if (await read(`sms-seen:${sid}`)) return twiml('');
  await keep(`sms-seen:${sid}`, '1', inbound.seen_seconds);
  const phone = normalPhone(params.get('From') ?? '');
  const text = (params.get('Body') ?? '').trim().slice(0, inbound.max_text_chars);
  if (!phone || !text) return twiml('');
  const owner = await ownerOf(phone);
  if (owner) {
    await deliver(owner, { text, client_id: `sms:${sid}` });
    return twiml('');
  }
  const found = await entryLeadForPhone(env, phone, read);
  if (!found) return twiml('');
  return twiml(inboundWelcome(found.entry, `${origin}/account?from=${encodeURIComponent(found.entry.from)}`));
}
