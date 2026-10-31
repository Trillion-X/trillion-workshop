// tools/send-messages/do-work/send-a-message.mjs
//
// PURPOSE
//   Sends one message (an email, a text, a Messages message on the person's Mac) to one person or a list, through
//   the provider the row names. Which provider, what it needs and how it is reached are DATA
//   (read-data/message-providers.json); an email's words can come from a template (read-data/message-templates.json)
//   or from the request. This file is the seam: it picks the provider's row, checks the request, hands the
//   provider's adapter its keys in the adapter's own environment, and answers who was sent to and who was not.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A provider key arrives on a private pipe (the row's invoke.credential_mounts: one descriptor per key, named in
//      the provider's row) and goes to the one adapter process in its environment. It is never in argv, a file, the
//      request or the answer.
//   2. No sending identity is shipped. An email has a sender the person gives (`from`, or a template merged with it);
//      with none, the request is refused rather than sent as somebody else.
//   3. Each recipient is sent to on their own and answered on their own. One failing recipient never hides the others.
//   4. A program on the person's own computer (Messages) gets the recipient and the body as separate arguments,
//      never woven into its script, and a permission refusal by the system fails closed with what to grant.
//
// USAGE
//   node send-a-message.mjs <provider id>             request on standard input, last line of standard output is { result: the answer }
//   node run-an-export.mjs send-a-message.mjs sendOnThisMac   (the computer row: Messages on this Mac)
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageRejectedError, readCustomHeaders } from '../read-data/check-message-headers.ts';
import { buildEmailMessage, selectDescriptor } from '../read-data/render-a-message.ts';
import { buildSendInvocation, isTccDenial } from '../read-data/render-a-send.ts';

const here = dirname(fileURLToPath(import.meta.url));
const data = name => JSON.parse(readFileSync(join(here, '..', 'read-data', name), 'utf8'));
const MAC_PROVIDER = 'messages-on-this-mac';
const TAIL = 8192;

/** The Mac refused the Automation event: a different failure from a rejected send, so a caller can show what to grant. */
export class MessageBlockedError extends Error {
  code = 'blocked_needs_grant';
}

export const providers = () => data('message-providers.json').providers;

/** The provider row with this id. An unknown id is refused with the ids that exist (no first-match fallback). */
export function providerOf(id, rows = providers()) {
  const row = rows.find(item => item.id === id);
  if (!row) throw new MessageRejectedError(`Unsupported provider: ${id}. Providers: ${rows.map(item => item.id).join(', ')}.`);
  return row;
}

function recipientsOf(request) {
  const list = Array.isArray(request.recipients) ? request.recipients : request.to === undefined ? [] : [request.to];
  const clean = list.map(item => (typeof item === 'string' ? item.trim() : ''));
  if (clean.length === 0 || clean.some(item => item === '')) throw new MessageRejectedError('recipients is required: give one address or number, or a list of them.');
  return clean;
}

function variablesOf(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new MessageRejectedError('variables must be an object.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item !== 'string' || item.trim() === '') throw new MessageRejectedError(`variables.${key} is required.`);
    return [key, item.trim()];
  }));
}

/** The words to send: a template rendered with the request's variables, or the request's own subject, html and text. */
export function messageOf(request, channel) {
  if (typeof request.template === 'string' && request.template !== '') {
    const merged = { ...(typeof request.message === 'object' && request.message !== null ? request.message : {}), ...(request.from ? { from: request.from } : {}) };
    const descriptor = selectDescriptor(request.templates ?? data('message-templates.json').things, request.template);
    return buildEmailMessage(descriptor, variablesOf(request.variables), merged);
  }
  if (channel === 'email') {
    for (const field of ['subject', 'html']) if (typeof request[field] !== 'string' || request[field].trim() === '') throw new MessageRejectedError(`${field} is required.`);
  } else if (typeof request.text !== 'string' && typeof request.subject !== 'string') {
    throw new MessageRejectedError('text is required.');
  }
  return { from: request.from, subject: request.subject, html: request.html, text: request.text };
}

function settingsOf(provider, request, message) {
  return Object.fromEntries(provider.settings.map(({ env, input }) => {
    const value = input === 'from' ? message.from ?? request.from : request[input];
    if (typeof value !== 'string' || value.trim() === '') throw new MessageRejectedError(`${input} is required.`);
    return [env, value.trim()];
  }));
}

function collect(child) {
  return new Promise((done, fail) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

/** Runs the provider's adapter script in a private folder holding the request as input.json; the folder goes afterwards. */
export async function runAdapter(provider, input, env) {
  const folder = mkdtempSync(join(tmpdir(), 'send-a-message-'));
  try {
    writeFileSync(join(folder, 'input.json'), JSON.stringify(input), { mode: 0o600 });
    const child = spawn(process.execPath, [join(here, provider.adapter)], { cwd: folder, env: { ...process.env, ...env } });
    return await collect(child);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Runs one command with a time limit, argv as given (never through a shell). */
export function runProcess(argv, timeoutMs) {
  return new Promise(done => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
    });
  });
}

async function sendOverProcess(provider, recipients, body, run) {
  const sent = [];
  for (const recipient of recipients) {
    const call = buildSendInvocation(provider, { recipient, body });
    const reply = await run(call.argv, call.timeout_ms);
    const out = reply.stdout.slice(-TAIL);
    const err = reply.stderr.slice(-TAIL);
    if (reply.code === 0 && out.includes(call.success_stdout_marker)) {
      sent.push({ recipient });
    } else if (isTccDenial(err, call.tcc_denial_patterns)) {
      throw new MessageBlockedError(call.tcc_remediation);
    } else {
      sent.push({ recipient, error: `Conversation channel rejected the send: ${err.trim() || `exit ${reply.code}`}` });
    }
  }
  return sent;
}

async function sendOverAdapter(provider, input, env, run) {
  const reply = await run(provider, input, env);
  let answer = null;
  try { answer = JSON.parse(reply.stdout); } catch { answer = null; }
  if (!Array.isArray(answer?.sent)) throw new Error(`${provider.label} did not answer: ${(reply.stderr || reply.stdout).trim().slice(-TAIL) || `exit ${reply.code}`}`);
  return answer.sent;
}

/**
 * Sends the request through the provider. `credentials` maps each environment name the provider's row lists to the
 * held value. Answers { provider, sent: [{ recipient, messageId? , error? }], said }.
 */
export async function sendMessage(request, { providerId, credentials = {}, rows = providers(), run = runAdapter, runCommand = runProcess } = {}) {
  const provider = providerOf(providerId, rows);
  const recipients = recipientsOf(request);
  const message = messageOf(request, provider.channel);
  const settings = settingsOf(provider, request, message);
  for (const { env, secret_name: name } of provider.credentials) {
    if (typeof credentials[env] !== 'string' || credentials[env].trim() === '') throw new MessageRejectedError(`No ${name} was handed to this run. Connect the ${provider.label} account first.`);
  }
  const headers = readCustomHeaders(request.headers);
  const secrets = Object.fromEntries(provider.credentials.map(({ env }) => [env, credentials[env].trim()]));
  const sent = provider.kind === 'process'
    ? await sendOverProcess(provider, recipients, message.text ?? message.subject ?? '', runCommand)
    : await sendOverAdapter(provider, {
      recipients, subject: message.subject, html: message.html, text: message.text, headers,
      ...(typeof request.idempotencyKey === 'string' ? { idempotencyKey: request.idempotencyKey } : {}),
    }, { ...settings, ...secrets }, run);
  const failed = sent.filter(item => item.error);
  const said = `Sent to ${sent.length - failed.length} of ${sent.length} through ${provider.label}.${failed.length ? ` Not sent: ${failed.map(item => `${item.recipient} (${item.error})`).join('; ')}` : ''}`;
  return { provider: provider.id, sent, said };
}

/** The computer row's export: Messages on the person's own Mac. */
export const sendOnThisMac = request => sendMessage(request, { providerId: MAC_PROVIDER });

/** Reads each held key from its private descriptor, as the provider's row names them. */
export function heldKeys(provider, read = descriptor => readFileSync(descriptor, 'utf8')) {
  return Object.fromEntries(provider.credentials.map(({ env, fd }) => {
    let value = '';
    try { value = read(fd); } catch { value = ''; }
    return [env, value];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const provider = providerOf(process.argv[2]);
    const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify({ result: await sendMessage(request, { providerId: provider.id, credentials: heldKeys(provider) }) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
