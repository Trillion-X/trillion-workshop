// src/share-visitor.mjs
//
// PURPOSE
//   Someone a share link was sent to proves their email without a Trillion account: they type it on the link's page,
//   get a 6-digit code (src/mail-sender.mjs sendMail, kind share-code), type it back, and this browser is remembered as
//   that email for record-sharing.json proof.visitor_days. The proved email is what the one share owner
//   (src/record-sharing.mjs admittedGrant) checks a link made for one email against, and what names who signed or paid
//   through a link that asks for it. Drive's visitor sharing and DocuSign's signer code are the same idea.
//
//   POST /share/<code>/prove { email }         sends a code when the link could be for that email (never says whether)
//   POST /share/<code>/prove { email, code }   checks it; the answer sets the visitor cookie
//
// NON-NEGOTIABLE INVARIANTS
//   1. A code is sent only to an email the link could admit: the link's own email, or any email for a link that names
//      nobody (anyone with it may act once they prove who they are). The page says the same words either way, so it
//      never tells a stranger which email a link was made for.
//   2. A code works once, for proof.code_minutes, and for proof.tries_per_code tries; it is kept only as its BLAKE3
//      identity, never in words.
//   3. The visitor cookie holds a random token; the email it stands for is kept server-side, so nothing a page sends can
//      name an email the browser did not prove.
//   4. Codes go through the one sender's per-person limits (src/mail-settings.json, kind share-code).
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import sharing from './record-sharing.json' with { type: 'json' };
import { normalEmail } from './sign-in-email.mjs';
import { sendMail } from './mail-sender.mjs';

export const SHARE_VISITOR_COOKIE = 'trillion_share_visitor';
const proof = sharing.proof;
const identity = text => bytesToHex(blake3(new TextEncoder().encode(text)));
const codeKey = (shareCode, email) => `share-proof:${identity(`${shareCode}\n${email}`)}`;
const visitorKey = token => `share-visitor:${identity(token)}`;
const poolOf = env => env.POOL?.get?.(env.POOL.idFromName('everyone')) ?? null;
const random = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);

/** The email this browser proved, or null. */
export async function provenEmail(request, envOrKv) {
  const token = (request.headers.get('cookie') ?? '').split(/;\s*/).find(part => part.startsWith(`${SHARE_VISITOR_COOKIE}=`))?.slice(SHARE_VISITOR_COOKIE.length + 1);
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  const pool = poolOf(envOrKv);
  if (pool?.shareVisitorEmail) return normalEmail(await pool.shareVisitorEmail(identity(token), Date.now()));
  const kept = await (envOrKv.APP_KV ?? envOrKv).get(visitorKey(token), 'json');
  return normalEmail(kept?.email);
}

/**
 * Sends a code to `email` for the link `shareCode` when `mayAdmit(email)` says the link could admit that email.
 * → { sent: true, email } whenever the email has a valid shape (invariant 1), or { error } in words for the page.
 */
export async function sendShareCode(env, { shareCode, email: given, sender, mayAdmit }) {
  const email = normalEmail(given);
  if (!email) return { error: 'Type a whole email address.' };
  if (!(await mayAdmit(email))) return { sent: true, email };
  const code = sixDigits();
  const expiresAt = Date.now() + proof.code_minutes * 60_000;
  const codeHash = identity(code);
  const pool = poolOf(env);
  if (pool?.putShareVisitorCode) await pool.putShareVisitorCode({ shareCode, email, codeHash, expiresAt });
  else await env.APP_KV.put(codeKey(shareCode, email), JSON.stringify({ code: codeHash, tries: 0, expires_at_ms: expiresAt }), { expirationTtl: proof.code_minutes * 60 });
  const values = { code, sender };
  const mailed = await sendMail(env, null, { kind: 'share-code', to: email, subject: fill(proof.email.subject, values), markdown: fill(proof.email.markdown, values) });
  if (!mailed.sent) {
    if (pool?.dropShareVisitorCode) await pool.dropShareVisitorCode(shareCode, email, codeHash);
    return { error: mailed.limited ? proof.too_many : `The code could not be sent: ${mailed.error}` };
  }
  return { sent: true, email };
}

/** Checks a code; when it is right, → { email, cookie } to set on the answer, else { error }. */
export async function checkShareCode(env, { shareCode, email: given, code }) {
  const email = normalEmail(given);
  const normalizedCode = typeof code === 'string' ? identity(code.replace(/\s+/g, '')) : '';
  const pool = poolOf(env);
  const now = Date.now();
  if (pool?.checkShareVisitorCode) {
    if (!email || !(await pool.checkShareVisitorCode({ shareCode, email, codeHash: normalizedCode, now, maxTries: proof.tries_per_code }))) return { error: proof.wrong_code };
  } else {
    const key = email ? codeKey(shareCode, email) : null;
    const kept = key ? await env.APP_KV.get(key, 'json') : null;
    if (!kept || !Number.isFinite(kept.expires_at_ms) || kept.expires_at_ms <= now || kept.tries >= proof.tries_per_code) return { error: proof.wrong_code };
    if (normalizedCode !== kept.code) {
      await env.APP_KV.put(key, JSON.stringify({ ...kept, tries: kept.tries + 1 }), { expirationTtl: Math.max(1, Math.ceil((kept.expires_at_ms - now) / 1000)) });
      return { error: proof.wrong_code };
    }
    await env.APP_KV.delete(key);
  }
  if (!email) return { error: proof.wrong_code };
  const token = random(24);
  const seconds = proof.visitor_days * 86_400;
  const provedAt = new Date(now).toISOString();
  if (pool?.putShareVisitorSession) await pool.putShareVisitorSession(identity(token), email, provedAt, now + seconds * 1000);
  else await env.APP_KV.put(visitorKey(token), JSON.stringify({ email, proved_at: provedAt }), { expirationTtl: seconds });
  return { email, cookie: `${SHARE_VISITOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/share/; Max-Age=${seconds}` };
}
