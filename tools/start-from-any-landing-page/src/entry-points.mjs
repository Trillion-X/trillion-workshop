// src/entry-points.mjs
//
// Purpose
//   Channel-native onboarding from any landing page. A visitor gives an email and/or a phone on a page; the answer is a
//   link per allowed channel that opens their own messaging app with the opening message ready, addressed to the AI's
//   own number. The page, the opening message, the persona and the channels are rows in src/entry-points.json.
//
// Non-negotiable invariants
//   1. Nothing here names a page, a persona or a channel: they are rows. A channel is a link template and the
//      environment value that holds its address; an entry point lists the channel ids it may use.
//   2. A channel whose address is not set is left out and named in `unavailable`. If none is set the answer is a plain
//      refusal naming what is missing, never an empty list of links.
//   3. Only keyed digests of the email and phone are kept (key: the contact key), for lead_days, so the first message
//      that arrives can be matched to the entry point it came from. The raw values are never stored or logged.
//   4. The same person giving the same contact again changes nothing.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from './entry-points.json' with { type: 'json' };
import { keyedContact, normalPhone } from './sign-in-phone.mjs';
import { secret } from './worker-secrets.mjs';

export class EntryPointError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const entries = new Map(data.entry_points.map(entry => [entry.id, entry]));
const channels = new Map(data.channels.map(channel => [channel.id, channel]));
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

const leadKey = (id, digest) => `entry-lead:${id}:${bytesToHex(blake3(new TextEncoder().encode(digest))).slice(0, 32)}`;

/** The entry point a text from this phone number was started from, or null: { entry, lead } (the stored lead, kept lead_days). */
export async function entryLeadForPhone(env, phone, read) {
  const key = secret(env, 'PHONE_INDEX_KEY');
  if (!key) return null;
  const digest = keyedContact(`phone:${phone}`, key);
  for (const entry of entries.values()) {
    const lead = await read(leadKey(entry.id, digest));
    if (lead) return { entry, lead };
  }
  return null;
}

/** The words that answer a first text from a lead who has no account yet. */
export const inboundWelcome = (entry, link) => fill(data.words.inbound_reply, { persona: entry.persona, link });

export const entryPointOf = id => entries.get(id) ?? null;
const byFrom = new Map(data.entry_points.map(entry => [entry.from, entry]));

/** What setup shows an AI about where the person came from: the entry point named, else the one their recorded `from` matches. */
export function entryPointForSetup(named, cameFrom) {
  const entry = (typeof named === 'string' && named ? entries.get(named) : null) ?? (typeof cameFrom?.from === 'string' ? byFrom.get(cameFrom.from) : null) ?? null;
  if (typeof named === 'string' && named && !entry) throw new EntryPointError(fill(data.words.no_entry, { id: named }), 404);
  return entry ? { id: entry.id, persona: entry.persona, opening_message: entry.opening_message, channels: entry.channels, source: named ? 'named' : 'came_from' } : null;
}

/** The links this entry point offers now: { links: [{ channel, label, url }], unavailable: [{ channel, why }] }. */
export function entryLinks(entry, env) {
  const links = [];
  const unavailable = [];
  for (const id of entry.channels) {
    const channel = channels.get(id);
    if (!channel) { unavailable.push({ channel: id, why: fill(data.words.channel_missing, { label: id, env: 'no such channel' }) }); continue; }
    const address = env[channel.address_env];
    if (typeof address !== 'string' || !address.trim()) { unavailable.push({ channel: id, why: fill(data.words.channel_missing, { label: channel.label, env: channel.address_env }) }); continue; }
    links.push({ channel: id, label: channel.label, url: fill(channel.link, { address: encodeURIComponent(address.trim()), body: encodeURIComponent(entry.opening_message) }) });
  }
  return { links, unavailable };
}

/**
 * Answers one landing-form submission: { entry, persona, links, voice_note } and keeps the digests for lead_days.
 * `keep(key, value, ttlSeconds)` stores one value; the caller supplies the store.
 */
export async function startFromEntry(env, id, input, keep) {
  const entry = entries.get(id);
  if (!entry) throw new EntryPointError(fill(data.words.no_entry, { id }), 404);
  const email = typeof input?.email === 'string' && input.email.trim() ? input.email.trim().toLowerCase() : null;
  const phone = typeof input?.phone === 'string' && input.phone.trim() ? normalPhone(input.phone) : null;
  if (email && !EMAIL.test(email)) throw new EntryPointError(data.words.bad_email);
  if (typeof input?.phone === 'string' && input.phone.trim() && !phone) throw new EntryPointError(data.words.bad_phone);
  if (!email && !phone) throw new EntryPointError(data.words.needs_contact);
  const { links, unavailable } = entryLinks(entry, env);
  if (!links.length) throw new EntryPointError(fill(data.words.no_channel, { id, missing: unavailable.map(one => one.why).join('; ') }), 503);
  const key = secret(env, 'PHONE_INDEX_KEY');
  if (!key) throw new EntryPointError(data.words.not_configured, 503);
  const at = new Date().toISOString();
  for (const [kind, value] of [['email', email], ['phone', phone]]) {
    if (!value) continue;
    const digest = keyedContact(`${kind}:${value}`, key);
    await keep(leadKey(id, digest), JSON.stringify({ entry: id, kind, digest, at }), data.lead_days * 86400);
  }
  return { entry: id, persona: entry.persona, opening_message: entry.opening_message, links, unavailable, ...(entry.voice_note?.allowed ? { voice_note: { max_seconds: entry.voice_note.max_seconds } } : {}) };
}
