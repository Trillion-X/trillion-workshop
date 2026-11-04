// An optional verified phone is a sign-in method on an existing account. The shared pool serializes its unique
// ownership, one-use codes and send budgets. SMS delivery is a separate provider binding.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SIGN_IN_EMAIL } from './sign-in-email.mjs';
import { secret } from './worker-secrets.mjs';

const enc = new TextEncoder();
const DAY = 86_400_000;
export const PHONE_CODE_MINUTES = SIGN_IN_EMAIL.code_minutes;
export const PHONE_CODE_DIGITS = SIGN_IN_EMAIL.code_digits;

export function normalPhone(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const phone = value.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

const keyed = (value, secret) => bytesToHex(blake3(enc.encode(value), { key: blake3(enc.encode(secret)) }));
/** A keyed digest of any contact value, the same construction as a phone key, so a value is never stored itself. */
export const keyedContact = keyed;
export function phoneKey(phone, secret) {
  if (!secret || !normalPhone(phone)) throw new Error('Phone sign-in is not configured.');
  return keyed(phone, secret);
}
export const phoneCodeKey = (purpose, userId, key) => `phone:${purpose}:${userId}:${key}`;

export function phoneTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS verified_phones (phone_key TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS phone_sends (key TEXT NOT NULL, at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS phone_sends_key ON phone_sends (key, at)');
  sql.exec('CREATE TABLE IF NOT EXISTS phone_tries (key TEXT NOT NULL, at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS phone_tries_key ON phone_tries (key, at)');
  sql.exec('CREATE TABLE IF NOT EXISTS phone_codes (code_key TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL)');
}

function budget(sql, table, limits, now) {
  // Expire every key, including one-off numbers and addresses that will never be requested again.
  sql.exec(`DELETE FROM ${table} WHERE at <= ?`, now - DAY);
  for (const [key, maximum] of limits) if (sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`, key).toArray()[0].n >= maximum) return false;
  for (const [key] of limits) sql.exec(`INSERT INTO ${table} (key, at) VALUES (?, ?)`, key, now);
  return true;
}

export const phoneOwner = (sql, key) => sql.exec('SELECT user_id FROM verified_phones WHERE phone_key = ?', key).toArray()[0]?.user_id ?? null;
export const phoneOf = (sql, userId) => sql.exec('SELECT phone_key, verified_at FROM verified_phones WHERE user_id = ?', userId).toArray()[0] ?? null;

export function askPhoneCode(sql, { key, purpose, userId, address, known, secret }, now = Date.now()) {
  const ip = keyed(String(address ?? 'unknown'), secret);
  const limits = [['all-requests', 3000], [`phone:${key}`, 6], [`ip:${ip}`, 20], ...(known ? [[`account:${userId}`, 12], ['service', 300]] : [])];
  if (!budget(sql, 'phone_sends', limits, now)) return { wait_minutes: 60 };
  return { code: known ? makePhoneCode(sql, phoneCodeKey(purpose, userId, key), secret, now) : null };
}

export function countPhoneTry(sql, { key, address, secret }, now = Date.now()) {
  const ip = keyed(String(address ?? 'unknown'), secret);
  return budget(sql, 'phone_tries', [['all-requests', 6000], [`phone:${key}`, 25], [`ip:${ip}`, 60]], now) ? { allowed: true } : { limited: true };
}
export function finishPhoneCode(sql, { key, purpose, userId, code, address, secret, counted = false, consumeOnRight = true }, now = Date.now()) {
  if (!counted && countPhoneTry(sql, { key, address, secret }, now).limited) return { limited: true };
  return { right: checkPhoneCode(sql, phoneCodeKey(purpose, userId, key), code, secret, now, consumeOnRight) };
}
export const cancelPhoneCode = (sql, { key, purpose, userId }) => sql.exec('DELETE FROM phone_codes WHERE code_key = ?', phoneCodeKey(purpose, userId, key));

const verifier = (codeKey, code, secret) => keyed(`${codeKey}:${code}`, secret);
function makePhoneCode(sql, codeKey, secret, now) {
  sql.exec('DELETE FROM phone_codes WHERE expires_at <= ?', now);
  const live = sql.exec('SELECT expires_at, tries FROM phone_codes WHERE code_key = ?', codeKey).toArray()[0];
  const madeAt = live ? live.expires_at - PHONE_CODE_MINUTES * 60_000 : null;
  if (live && live.tries < SIGN_IN_EMAIL.tries_per_code && now - madeAt < SIGN_IN_EMAIL.resend_after_minutes * 60_000) return null;
  let code = '';
  while (code.length < PHONE_CODE_DIGITS) {
    const bytes = crypto.getRandomValues(new Uint8Array(PHONE_CODE_DIGITS * 2));
    for (const byte of bytes) if (byte < 250 && code.length < PHONE_CODE_DIGITS) code += String(byte % 10);
  }
  sql.exec('INSERT OR REPLACE INTO phone_codes (code_key, verifier, expires_at, tries) VALUES (?, ?, ?, 0)', codeKey, verifier(codeKey, code, secret), now + PHONE_CODE_MINUTES * 60_000);
  return code;
}
function checkPhoneCode(sql, codeKey, code, secret, now, consumeOnRight) {
  const row = sql.exec('SELECT verifier, expires_at, tries FROM phone_codes WHERE code_key = ?', codeKey).toArray()[0];
  if (!row) return false;
  if (row.expires_at <= now || row.tries >= SIGN_IN_EMAIL.tries_per_code) {
    sql.exec('DELETE FROM phone_codes WHERE code_key = ?', codeKey);
    return false;
  }
  const typed = typeof code === 'string' ? code.replace(/\D/g, '') : '';
  if (typed.length === PHONE_CODE_DIGITS && verifier(codeKey, typed, secret) === row.verifier) {
    if (consumeOnRight) sql.exec('DELETE FROM phone_codes WHERE code_key = ?', codeKey);
    return true;
  }
  sql.exec('UPDATE phone_codes SET tries = tries + 1 WHERE code_key = ?', codeKey);
  return false;
}

export function claimPhone(sql, userId, key, at = new Date().toISOString()) {
  const owner = phoneOwner(sql, key);
  if (owner && owner !== userId) return false;
  sql.exec('DELETE FROM verified_phones WHERE user_id = ?', userId);
  sql.exec('INSERT INTO verified_phones (phone_key, user_id, verified_at) VALUES (?, ?, ?)', key, userId, at);
  return true;
}
export const dropPhone = (sql, userId) => sql.exec('DELETE FROM verified_phones WHERE user_id = ?', userId);

export const allowedPhone = (env, phone) => String(env.SMS_ALLOWED_PREFIXES ?? '').split(',').map(part => part.trim()).filter(part => /^\+\d{1,4}$/.test(part)).some(prefix => phone.startsWith(prefix));
export const smsReady = env => Boolean(env.SMS_TWILIO_ACCOUNT_SID && secret(env, 'SMS_TWILIO_AUTH_TOKEN') && env.SMS_TWILIO_FROM && secret(env, 'PHONE_INDEX_KEY') && String(env.SMS_ALLOWED_PREFIXES ?? '').trim());

export async function sendPhoneCode(env, phone, code, fetcher = fetch) {
  if (!smsReady(env) || !allowedPhone(env, phone)) return { sent: false, reason: 'not_configured' };
  const body = new URLSearchParams({ To: phone, From: env.SMS_TWILIO_FROM, Body: `Your Trillion code is ${code}. It works once for ${PHONE_CODE_MINUTES} minutes. If you did not ask for it, ignore this text.` });
  try {
    const answer = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.SMS_TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST', headers: { authorization: `Basic ${btoa(`${env.SMS_TWILIO_ACCOUNT_SID}:${secret(env, 'SMS_TWILIO_AUTH_TOKEN')}`)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(8000),
    });
    return { sent: answer.status === 201, reason: answer.status === 201 ? null : `provider_${answer.status}` };
  } catch { return { sent: false, reason: 'provider_unreachable' }; }
}
