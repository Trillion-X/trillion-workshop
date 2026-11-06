// tools/pull-from-connected-accounts/do-work/signal-client.mjs
//
// The Signal client on the person's own computer: the computer-kind rows tool:read-my-signal-messages-on-this-computer
// and tool:link-signal-on-this-computer run it. It starts signal-cli (a program the rows declare in invoke.programs, with
// the Java it needs; the engine fetches both, checks their pinned BLAKE3 and puts their folders on this run's PATH) and
// keeps signal-cli's whole account (its keys, its message store) in the folder the engine keeps for this tool between
// runs (invoke.kept_folder, handed in as `client_folder`). Nothing here is a phone number, a token or a login: the
// client holds its own.
//
// - read: `signal-cli -o json receive` prints envelopes; each is folded into the `signal` pull's contract
//   (read-data/signal-envelopes.mjs) and handed to that pull (pull.mjs `pullFromAnAccount('signal', ...)`) in this
//   same run, so the conversations land in the person's records. Signal's server hands a message to a linked device
//   once, so what was received is written to `pending` in the client folder first and removed only after the pull
//   kept it; a run that fails after receiving hands it in again at the next run.
// - link: `signal-cli link` prints a `sgnl://linkdevice` address and waits for the phone to scan it. This prints the
//   address and its QR code (text and SVG) as one JSON line at once, so whatever shows the run's output (the session's
//   read) can show the code, and answers `linked` once the phone has scanned it.
// - A run that is not linked yet answers `needs_link` and starts nothing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { encode, renderSVG, renderUnicodeCompact } from 'uqr';
import { envelopesToConversations, readEnvelopeLines } from '../read-data/signal-envelopes.mjs';
import { pullFromAnAccount } from './pull.mjs';

const CLIENT = 'signal-cli';
const PENDING = 'trillion-pending.jsonl';
const DEVICE_NAME = 'Trillion on this computer';
const LINK_ADDRESS = /^sgnl:\/\/linkdevice\?\S+$/;
const most = (value, fallback, top) => (Number.isInteger(value) && value >= 1 ? Math.min(value, top) : fallback);

/** Whatever the client printed to its error stream, with every phone number in it hidden, at most its last 300 characters. */
export const scrubbed = said => String(said ?? '').replace(/\+\d{6,15}/g, '+…').trim().slice(-300);

/** The client folder the engine handed in, made if missing. */
function folderOf(clientFolder) {
  if (typeof clientFolder !== 'string' || !isAbsolute(clientFolder)) {
    throw new Error('client_folder must be the absolute folder the engine keeps for this tool (invoke.kept_folder fills it).');
  }
  mkdirSync(clientFolder, { recursive: true, mode: 0o700 });
  return clientFolder;
}

/** The service id of the account signal-cli keeps in `folder` (its data/accounts.json), or null when none is linked. */
export function linkedAccount(folder) {
  try {
    const accounts = JSON.parse(readFileSync(join(folder, 'data', 'accounts.json'), 'utf8')).accounts ?? [];
    const uuid = accounts.map(account => account?.uuid).find(id => typeof id === 'string' && id.length);
    return uuid ?? null;
  } catch {
    return null;
  }
}

/**
 * The environment signal-cli runs in: this run's own (its PATH holds the fetched Java), and Java told to reach the
 * internet through the engine's loopback proxy when the run has one (Java does not read HTTPS_PROXY itself).
 */
export function clientEnvironment(environment = process.env) {
  const proxy = environment.HTTPS_PROXY ?? environment.https_proxy;
  const options = [];
  if (proxy) {
    const address = new URL(proxy);
    for (const scheme of ['https', 'http']) options.push(`-D${scheme}.proxyHost=${address.hostname}`, `-D${scheme}.proxyPort=${address.port}`);
    options.push('-Dhttp.nonProxyHosts=localhost|127.0.0.1');
  }
  const own = environment.JAVA_TOOL_OPTIONS ? [environment.JAVA_TOOL_OPTIONS] : [];
  return { ...environment, ...(options.length ? { JAVA_TOOL_OPTIONS: [...own, ...options].join(' ') } : {}) };
}

const needsLink = (account) => ({
  source: 'signal', account, status: 'needs_link', self_id: null, new_messages: 0, received: 0,
  said: 'Signal is not linked on this computer yet. Run tool:link-signal-on-this-computer, then on your phone open Signal, Settings, Linked devices, Link new device, and scan the code it shows.',
});

/**
 * One read: receive what Signal holds for this computer, fold it into conversations and keep them through the `signal`
 * pull. Input: { input: { account?, timeout_seconds?, most_messages?, most_threads? }, client_folder }.
 */
export async function readSignalOnThisComputer({ input = {}, client_folder: clientFolder } = {}, context = {}) {
  const folder = folderOf(clientFolder);
  const account = typeof input.account === 'string' && input.account ? input.account : 'default';
  const selfId = linkedAccount(folder);
  if (!selfId) return needsLink(account);
  const pending = join(folder, PENDING);
  const before = existsSync(pending) ? readFileSync(pending, 'utf8') : '';
  const args = ['--config', folder, '-o', 'json', 'receive', '--timeout', String(most(input.timeout_seconds, 5, 60)),
    '--max-messages', String(most(input.most_messages, 1000, 5000)), '--ignore-attachments', '--ignore-stories', '--ignore-avatars', '--ignore-stickers'];
  const run = (context.spawnSync ?? spawnSync)(CLIENT, args, { encoding: 'utf8', env: clientEnvironment(), maxBuffer: 64 * 1024 * 1024, timeout: 110_000 });
  const printed = run.stdout ?? '';
  // What arrived is written down before anything else, so a failure from here on never loses it.
  if (printed.trim()) {
    writeFileSync(`${pending}.new`, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${printed}`, { mode: 0o600 });
    renameSync(`${pending}.new`, pending);
  }
  if (run.error || run.status !== 0) {
    const why = run.error?.code === 'ENOENT' ? 'signal-cli could not be started on this computer' : `signal-cli stopped (${scrubbed(run.stderr) || `exit ${run.status ?? run.signal}`})`;
    if (!printed.trim()) {
      return { source: 'signal', account, status: 'unreachable', self_id: selfId, new_messages: 0, received: 0, errors: [why],
        said: `Nothing was read from Signal: ${why}. Nothing kept was changed; run it again later.` };
    }
  }
  const { envelopes, unreadable } = readEnvelopeLines(existsSync(pending) ? readFileSync(pending, 'utf8') : '');
  const { conversations, left_out: leftOut } = envelopesToConversations(envelopes, selfId);
  const pulled = await pullFromAnAccount('signal', { self_id: selfId, conversations, account,
    ...(input.most_threads ? { most_threads: input.most_threads } : {}) }, context);
  if (pulled.status === 'pulled' && !(pulled.errors ?? []).length) rmSync(pending, { force: true });
  const notes = [];
  if (leftOut) notes.push(`${leftOut} envelope${leftOut === 1 ? ' was' : 's were'} not a message (receipts, typing, reactions, group changes)`);
  if (unreadable) notes.push(`${unreadable} printed line${unreadable === 1 ? ' was' : 's were'} not an envelope`);
  return { ...pulled, received: envelopes.length, left_out: leftOut, said: [pulled.said, ...notes].filter(Boolean).join(' ') };
}

/** The QR code of a link address, as text a terminal draws and as SVG a page draws. */
export function linkCode(address) {
  return { link: address, qr_text: renderUnicodeCompact(address), qr_svg: renderSVG(address), size: encode(address).size };
}

/**
 * Link this computer as a Signal device. Prints `{ state: "scan", link, qr_text, qr_svg }` as soon as signal-cli gives
 * the address, then answers `{ state: "linked", self_id }` once the phone scanned it, or why not. Input: { client_folder }.
 */
export async function linkSignalOnThisComputer({ client_folder: clientFolder } = {}, context = {}) {
  const folder = folderOf(clientFolder);
  const already = linkedAccount(folder);
  if (already) return { state: 'linked', self_id: already, said: 'Signal is already linked on this computer.' };
  const child = (context.spawn ?? spawn)(CLIENT, ['--config', folder, 'link', '-n', DEVICE_NAME], { env: clientEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (LINK_ADDRESS.test(line.trim())) console.log(JSON.stringify({ state: 'scan', ...linkCode(line.trim()),
      said: 'On your phone open Signal, Settings, Linked devices, Link new device, and scan this code.' }));
  });
  const code = await new Promise(done => child.on('close', done));
  const self = linkedAccount(folder);
  if (code === 0 && self) return { state: 'linked', self_id: self, said: 'Signal is linked on this computer. tool:read-my-signal-messages-on-this-computer now reads it.' };
  return { state: 'not_linked', self_id: null, said: `Signal was not linked: ${scrubbed(errors) || `signal-cli ended with ${code}`}. Run it again and scan the new code within a minute.` };
}
