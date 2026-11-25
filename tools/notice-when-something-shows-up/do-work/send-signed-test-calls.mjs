import { realpathSync } from 'node:fs';
// tools/notice-when-something-shows-up/do-work/send-signed-test-calls.mjs
//
// The container tool `tool:send-signed-test-calls` (tool-rows.json): proves a signed webhook receiver the way the service that
// calls it would, with made-up events: a call signed with the person's own held signing secret, one with a wrong signature,
// one with none, one too old, one too large, and the very same signed call sent again. It answers each call's status and the
// receiver's reply, and nothing else.
//
// The signing secret is never in the request, argv, a file or the environment: the engine hands the person's own held
// value to this one process on a private pipe, descriptor 3 (the row's invoke.credential_mounts { fd: 3 }). It is used only
// for the HMAC, in memory. The answer never carries it, a digest of it, or a signature made with it; the receiver's reply
// is cut to a few hundred characters and any appearance of the secret in it is replaced.
//
// Input
//   url        the receiver's https address (the row's internet rule refuses private and local addresses)
//   sign       how the service signs: { signed, hash, encoding, secret_prefix?, secret_encoding? }, the same fields as a
//              signing rule of do-work/mechanisms/signing-rules.json ("{id}.{ts}.{body}", sha256, base64, whsec_, base64)
//   headers    the headers each call carries, by name, each a template of {id}, {ts} and {sig}
//              ({"svix-id": "{id}", "svix-timestamp": "{ts}", "svix-signature": "v1,{sig}"})
//   calls      in order, each { label, body, signature?, age_seconds?, pad_bytes?, same_as? }:
//              body          the made-up event (an object or text), sent as the call's raw bytes
//              signature     "good" (default), "bad" (a wrong one of the right shape) or "none" (no signature headers)
//              age_seconds   how far back its timestamp is (default 0): past the receiver's window, a replay it must refuse
//              pad_bytes     a field of that many bytes added to the body, to go over the receiver's size cap
//              same_as       the label of an earlier call: send exactly that call again (its id, timestamp, body and signature)
//
// Answer: { calls: [{ label, sent_at, status, reply }] }
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SECRET_DESCRIPTOR = 3;
const REPLY_CHARACTERS = 400;
const MOST_CALLS = 20;

const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };

/** The input as this tool reads it, or a refusal naming what to fix. */
export function requestOf(input) {
  if (!input || typeof input !== 'object') refuse('Give url, sign, headers and calls.');
  let url;
  try { url = new URL(input.url); } catch { refuse('url must be the receiver\'s https address.'); }
  if (url.protocol !== 'https:') refuse('url must be an https address.');
  const { sign, headers, calls } = input;
  if (!sign || typeof sign.signed !== 'string' || !/\{body\}/.test(sign.signed) || !['sha256', 'sha1', 'sha512'].includes(sign.hash) || !['base64', 'hex'].includes(sign.encoding)) {
    refuse('sign needs signed (a template naming {body}), hash (sha256, sha1 or sha512) and encoding (base64 or hex).');
  }
  if (!headers || typeof headers !== 'object' || !Object.values(headers).some((value) => String(value).includes('{sig}'))) refuse('headers must name the header that carries {sig}.');
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MOST_CALLS) refuse(`calls must list 1 to ${MOST_CALLS} calls.`);
  const labels = new Set();
  for (const call of calls) {
    if (typeof call?.label !== 'string' || !call.label || labels.has(call.label)) refuse('each call needs its own label.');
    if (call.same_as !== undefined && !labels.has(call.same_as)) refuse(`call ${call.label} names same_as ${call.same_as}, which is not an earlier call.`);
    if (call.same_as === undefined && call.body === undefined) refuse(`call ${call.label} needs a body.`);
    if (call.signature !== undefined && !['good', 'bad', 'none'].includes(call.signature)) refuse(`call ${call.label}: signature is good, bad or none.`);
    labels.add(call.label);
  }
  return { url: url.href, sign, headers, calls };
}

/** The key bytes a signing secret names: its prefix taken off, then decoded as the rule says (raw text when it says none). */
const keyOf = (secret, sign) => {
  const value = sign.secret_prefix && secret.startsWith(sign.secret_prefix) ? secret.slice(sign.secret_prefix.length) : secret;
  return sign.secret_encoding === 'base64' ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8');
};

/** The headers of one call: the templates filled with its id, timestamp and signature; none of the signature headers for "none". */
const headersOf = (templates, { id, ts, sig }) => Object.fromEntries(Object.entries(templates)
  .filter(([, template]) => sig !== null || !/\{(sig|id|ts)\}/.test(template))
  .map(([name, template]) => [name, String(template).replaceAll('{id}', id).replaceAll('{ts}', ts).replaceAll('{sig}', sig ?? '')]));

/** Sends the calls in order and answers each one's status and the receiver's reply (cut, the secret replaced). */
export async function sendCalls({ secret, input, fetchImpl = fetch, now = () => Date.now() }) {
  if (typeof secret !== 'string' || secret.replace(/\r?\n$/, '') === '') refuse('No signing secret was handed to this run: name the held secret in secret_name.');
  const held = secret.replace(/\r?\n$/, '');
  const { url, sign, headers, calls } = requestOf(input);
  const key = keyOf(held, sign);
  const signWith = (id, ts, body, chosen) => {
    if (chosen === 'none') return null;
    const good = createHmac(sign.hash, key).update(sign.signed.replaceAll('{id}', id).replaceAll('{ts}', ts).replaceAll('{body}', body)).digest(sign.encoding);
    if (chosen !== 'bad') return good;
    // A wrong signature of the same length and alphabet, so only its value is wrong.
    return createHmac(sign.hash, Buffer.from(`not-the-secret-${randomUUID()}`)).update(body).digest(sign.encoding);
  };
  const made = new Map();
  const answers = [];
  for (const call of calls) {
    let sent;
    if (call.same_as !== undefined) {
      sent = made.get(call.same_as);
    } else {
      const text = typeof call.body === 'string' ? call.body : JSON.stringify(call.pad_bytes ? { ...call.body, pad: 'x'.repeat(call.pad_bytes) } : call.body);
      const id = `msg_test_${randomUUID()}`;
      const ts = String(Math.floor(now() / 1000) - (Number.isInteger(call.age_seconds) ? call.age_seconds : 0));
      sent = { body: text, headers: { 'content-type': 'application/json', ...headersOf(headers, { id, ts, sig: signWith(id, ts, text, call.signature ?? 'good') }) } };
    }
    made.set(call.label, sent);
    const sentAt = new Date(now()).toISOString();
    let status = 0;
    let reply = '';
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: sent.headers, body: sent.body, signal: AbortSignal.timeout(20000) });
      status = response.status;
      reply = (await response.text()).slice(0, REPLY_CHARACTERS);
    } catch (error) {
      reply = `the receiver did not answer: ${String(error?.message ?? error).slice(0, 200)}`;
    }
    answers.push({ label: call.label, sent_at: sentAt, status, reply: reply.replaceAll(held, '[redacted]') });
  }
  return { calls: answers };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let secret = '';
  try { secret = readFileSync(SECRET_DESCRIPTOR, 'utf8'); } catch { secret = ''; }
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await sendCalls({ secret, input })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
