// tools/take-payments/do-work/register-a-webhook-endpoint.mjs
//
// Registers one Stripe webhook endpoint and keeps its signing secret, which Stripe shows only in the reply that creates it.
// The secret never reaches argv, a file, a log or this program's output: it goes as {name, value, hosts} JSON on the stdin of the
// keep command given after `--` (the person's vault put that reads its input on stdin), and nowhere else.
//
//   <reader of the Stripe key> | node register-a-webhook-endpoint.mjs --url URL --event TYPE [--event TYPE]... \
//       --keep-as NAME --hosts HOST[,HOST...] -- KEEP_COMMAND [ARG]...
//
// The Stripe key comes on stdin and is used only in the Authorization header (stripe-send.mjs). An endpoint already registered
// for URL is refused, because its secret cannot be read again. When the keep command fails, the endpoint just made is deleted,
// so a second run can make it again. The output is one JSON line: {endpoint_id, kept_as}.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStripeSender, StripeError } from './stripe-send.mjs';

const ENDPOINTS = 'https://api.stripe.com/v1/webhook_endpoints';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

/** The arguments: {url, events, keep_as, hosts, keep}. Refuses a missing or unknown one. */
export function argumentsOf(argv) {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) throw new Error('give the keep command after --');
  const asked = { url: null, events: [], keep_as: null, hosts: [], keep: argv.slice(split + 1) };
  const words = argv.slice(0, split);
  for (let at = 0; at < words.length; at += 2) {
    const [flag, value] = [words[at], words[at + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--url') asked.url = value;
    else if (flag === '--event') asked.events.push(value);
    else if (flag === '--keep-as') asked.keep_as = value;
    else if (flag === '--hosts') asked.hosts = value.split(',').filter(Boolean);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!asked.url?.startsWith('https://')) throw new Error('--url is the https address Stripe sends events to');
  if (!asked.events.length) throw new Error('give at least one --event');
  if (!asked.keep_as) throw new Error('--keep-as names where the signing secret is kept');
  if (!asked.hosts.length) throw new Error('--hosts names where the signing secret may be used');
  return asked;
}

/** Runs the keep command with `input` on its stdin; resolves when it exits 0. Its output is not passed on. */
export function keepWith(command, input) {
  return new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', error => fail(new Error(`the keep command did not start: ${error.code ?? error.message}`)));
    child.on('exit', code => code === 0 ? done() : fail(new Error(`the keep command exited ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

/** Registers the endpoint and keeps its secret. `send` is a Stripe sender; `keep(input)` keeps one {name, value, hosts}. */
export async function registerWebhookEndpoint({ url, events, keep_as, hosts }, { send, keep }) {
  const listed = await send({ method: 'GET', url: `${ENDPOINTS}?limit=100`, headers: {} });
  if ((listed.data ?? []).some(endpoint => endpoint.url === url)) throw new StripeError(`An endpoint for ${url} is already registered; its signing secret cannot be read again.`, 409);
  const form = new URLSearchParams({ url });
  for (const type of events) form.append('enabled_events[]', type);
  const made = await send({ method: 'POST', url: ENDPOINTS, headers: FORM, body: form.toString() });
  if (typeof made.id !== 'string' || typeof made.secret !== 'string' || !made.secret) throw new StripeError('Stripe made no endpoint with a signing secret.');
  try {
    await keep({ name: keep_as, value: made.secret, hosts });
  } catch (error) {
    await send({ method: 'DELETE', url: `${ENDPOINTS}/${encodeURIComponent(made.id)}`, headers: {} });
    throw new Error(`${error.message}; endpoint ${made.id} was deleted again`);
  }
  return { endpoint_id: made.id, kept_as: keep_as };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const asked = argumentsOf(process.argv.slice(2));
  const key = readFileSync(0, 'utf8').trim();
  if (!key) throw new Error('no Stripe key arrived on stdin');
  const answer = await registerWebhookEndpoint(asked, { send: makeStripeSender({ key }), keep: input => keepWith(asked.keep, input) });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
