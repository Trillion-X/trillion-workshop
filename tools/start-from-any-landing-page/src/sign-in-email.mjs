// src/sign-in-email.mjs
// Signing in without a passkey on this device: a one-time code sent to the account's email. Its words, limits and
// sending row are DATA (src/sign-in-email.json); the codes and the send counts live in the shared pool's storage
// (src/pool.mjs), where the checking request always reads what the sending one wrote.
//
// Purpose
//   A passkey lives on the device (or password manager) that made it. A person on a new phone, a private window, a
//   work profile or a browser that cannot use passkeys still gets in: they ask for a code, type it, and are signed in,
//   then offered a passkey on this device.
//
// Non-negotiable invariants
//   1. Asking for a code answers the same words whether or not the email has an account, so nobody learns who has one.
//   2. A code is kept only as a BLAKE3 hash bound to its email, works once, ends after code_minutes, and dies after
//      tries_per_code wrong tries.
//   3. Sends are limited per email and per network address within a window; a refused send says how long to wait.
//   4. The email-to-account index keeps only the BLAKE3 hash of the email in its key.
//   5. An email enters the index only once its inbox has answered a code bound to that account, or from a paid
//      checkout (src/sign-in-methods.mjs confirmAccountEmail).
//
import settings from './sign-in-email.json' with { type: 'json' };
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const SIGN_IN_EMAIL = settings;
const hash = text => bytesToHex(blake3(new TextEncoder().encode(text)));
const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** The email in the one form every lookup uses, or null when it is not an email address. */
export function normalEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EMAIL_SHAPE.test(email) ? email : null;
}

/** The words at `key`, filled from `values`. */
export const said = (key, values = {}) => settings.words[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

// ---- Which accounts an email belongs to (APP_KV) ----

const indexKey = email => `account-email:${hash(email)}`;

/** Every account that goes by `email`: those named by it, and a buyer whose checkout used it. */
export async function accountsForEmail(kv, value) {
  const email = normalEmail(value);
  if (!email) return [];
  const listed = (await kv.get(indexKey(email), 'json')) ?? [];
  const bought = await kv.get(`customer-email:${email}`);
  return [...new Set([...listed, ...(bought ? [bought] : [])])];
}

/** An account whose name is an email becomes findable by it; any other name changes nothing. */
export async function rememberAccountEmail(kv, userId, name) {
  const email = normalEmail(name);
  if (!email) return;
  const listed = (await kv.get(indexKey(email), 'json')) ?? [];
  if (!listed.includes(userId)) await kv.put(indexKey(email), JSON.stringify([...listed, userId]));
}

/** A deleted account stops being found by its email. */
export async function forgetAccountEmail(kv, userId, name) {
  const email = normalEmail(name);
  if (!email) return;
  const listed = ((await kv.get(indexKey(email), 'json')) ?? []).filter(id => id !== userId);
  await (listed.length ? kv.put(indexKey(email), JSON.stringify(listed)) : kv.delete(indexKey(email)));
}

// ---- Codes and send counts (the pool's SQLite) ----

export function signInCodeTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS sign_in_codes (email_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS sign_in_sends (key TEXT NOT NULL, at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS sign_in_sends_key ON sign_in_sends (key, at)');
}

const codeHash = (emailHash, code) => hash(`${emailHash}:${code}`);

/** Counts one ask under each of `limits` ([key, most asks]) within `window_minutes`; → { allowed: true }, or
 *  { wait_minutes } when any key was asked too often (then nothing is counted). */
export function countAsks(sql, limits, windowMinutes, now = Date.now()) {
  for (const [key] of limits) sql.exec('DELETE FROM sign_in_sends WHERE key = ? AND at <= ?', key, now - windowMinutes * 60_000);
  for (const [key, limit] of limits) {
    if (sql.exec('SELECT COUNT(*) AS n FROM sign_in_sends WHERE key = ?', key).toArray()[0].n >= limit) return { wait_minutes: windowMinutes };
  }
  for (const [key] of limits) sql.exec('INSERT INTO sign_in_sends (key, at) VALUES (?, ?)', key, now);
  return { allowed: true };
}

/** Counts one ask for a code by `email` from `address`; → { allowed: true } or { wait_minutes } when either asked too often. */
export function countSignInSend(sql, { email, address }, now = Date.now()) {
  return countAsks(sql, [[`email:${hash(email)}`, settings.sends.per_email], [`address:${hash(String(address ?? ''))}`, settings.sends.per_address]], settings.sends.window_minutes, now);
}

/** A new code for `email`, replacing any earlier one; only its hash is kept. While a code made within
 *  `resend_after_minutes` still works, asking again makes none and → null, so nothing more is emailed and the code
 *  already in the inbox keeps working; after that, the earlier email is taken as lost and a new code replaces it. */
export function makeSignInCode(sql, email, now = Date.now(), random = bytes => crypto.getRandomValues(bytes)) {
  sql.exec('DELETE FROM sign_in_codes WHERE expires_at <= ?', now);
  const emailHash = hash(email);
  const live = sql.exec('SELECT expires_at, tries FROM sign_in_codes WHERE email_hash = ?', emailHash).toArray()[0];
  const madeAt = live ? live.expires_at - settings.code_minutes * 60_000 : null;
  if (live && live.tries < settings.tries_per_code && now - madeAt < settings.resend_after_minutes * 60_000) return null;
  const code = uniformDigits(settings.code_digits, random);
  sql.exec('INSERT OR REPLACE INTO sign_in_codes (email_hash, code_hash, expires_at, tries) VALUES (?, ?, ?, 0)', emailHash, codeHash(emailHash, code), now + settings.code_minutes * 60_000);
  return code;
}

/** Whether `code` is the live code for `email`; a right code is used up, a wrong one counts a try. */
export function checkSignInCode(sql, { email, code }, now = Date.now()) {
  const emailHash = hash(email);
  const row = sql.exec('SELECT code_hash, expires_at, tries FROM sign_in_codes WHERE email_hash = ?', emailHash).toArray()[0];
  if (!row || row.expires_at <= now || row.tries >= settings.tries_per_code) return false;
  const typed = typeof code === 'string' ? code.replace(/\D/g, '') : '';
  if (typed.length === settings.code_digits && codeHash(emailHash, typed) === row.code_hash) {
    sql.exec('DELETE FROM sign_in_codes WHERE email_hash = ?', emailHash);
    return true;
  }
  sql.exec('UPDATE sign_in_codes SET tries = tries + 1 WHERE email_hash = ?', emailHash);
  return false;
}

/** End a code when delivery failed; a later request can make a fresh one. */
export function cancelSignInCode(sql, email) { sql.exec('DELETE FROM sign_in_codes WHERE email_hash = ?', hash(email)); }

// Digits drawn without bias: each is a random byte below 250, taken modulo 10.
function uniformDigits(count, random) {
  let digits = '';
  while (digits.length < count) {
    for (const byte of random(new Uint8Array(count * 2))) if (byte < 250 && digits.length < count) digits += String(byte % 10);
  }
  return digits;
}
