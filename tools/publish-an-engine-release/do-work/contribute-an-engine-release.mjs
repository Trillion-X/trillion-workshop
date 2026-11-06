// tools/publish-an-engine-release/do-work/contribute-an-engine-release.mjs
//
// Run by a builder for one more target (a computer of that target, or a hosted runner of it, such as a macOS arm64
// runner on each push to the engine repository's branch): after it built `trillion-local` at a commit with
// TRILLION_RELEASE_COMMIT and TRILLION_RELEASE_SEQUENCE set, pack the program and the commit's product/ folder exactly
// as publish does (`packRelease`), sign the entry with this builder's own Ed25519 key (release-feed.mjs `signEntry`),
// and POST the tar.gz to the feed's builder at its `entry_path`, the entry as base64 JSON in the `entry_header` header.
// The feed's builder takes it only when the key is one it accepts, and serves it from the one feed every computer
// already reads (publish-an-engine-release.mjs `accept`). The target is the host line of `rustc -vV` (or the request's
// own): a target is data, and this file names no machine.
//
// The signing key (PKCS#8 PEM) arrives on standard input only: it is in no argv, file, log or answer.
//
// usage: contribute-an-engine-release.mjs contribute REQUEST_FILE   (signing key on standard input)
//        contribute-an-engine-release.mjs public-key                (signing key on standard input; prints its public half)
//        contribute-an-engine-release.mjs make-key                  (prints a new key on standard output, once, for the vault)
//
// request: { source, program, entries_url, commit?, sequence?, target?, rustc?, urgent? } — `source` is the checkout
// with full first-parent history, `program` the built trillion-local; paths relative to the request file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget, packRelease, privateInput, runProgram } from './publish-an-engine-release.mjs';
import { checkCommit, checkTarget, newSigningKey, publicKeyHex, settings, signEntry } from './release-feed.mjs';

const refuse = (message, exit = 1) => Object.assign(new Error(message), { exit });

/** The entry header's value: the entry as base64 of its JSON. */
export const entryHeader = entry => Buffer.from(JSON.stringify(entry), 'utf8').toString('base64');

/** The entry read back from that header, or null when it is not base64 JSON of an object. */
export function readEntryHeader(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]{1,8192}$/.test(value)) return null;
  try {
    const entry = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  } catch { return null; }
}

/** Pack and sign one release for this builder's target; answers { entry, body } (the entry has no url: the feed's
 *  builder names where it serves the body). */
export async function packAndSign(request, privateKey) {
  const source = request.source, program = request.program;
  if (!isAbsolute(source ?? '') || !isAbsolute(program ?? '')) throw refuse('source and program must be paths to the checkout and the built trillion-local.', 2);
  const git = args => runProgram('git', ['-C', source, ...args]);
  const commit = checkCommit(request.commit ?? (await git(['rev-parse', 'HEAD'])).trim());
  const sequence = request.sequence ?? Number((await git(['rev-list', '--count', '--first-parent', commit])).trim());
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw refuse('The sequence is not a whole number above 0: the checkout needs its full first-parent history (fetch-depth 0).', 2);
  const target = checkTarget(request.target ?? await hostTarget(request.rustc ?? 'rustc'));
  const trailer = (await git(['log', '-1', `--format=%(trailers:key=${settings.urgent_trailer},valueonly)`, commit])).trim().toLowerCase();
  const urgent = request.urgent === true || trailer.split('\n').includes('true');
  const scratch = mkdtempSync(join(tmpdir(), 'engine-release-'));
  try {
    const file = join(scratch, `${target}.tar.gz`);
    const { content, bytes } = packRelease({ program, source, file });
    const signed = signEntry({ commit, sequence, target, content, bytes, urgent }, privateKey);
    return { entry: signed, body: readFileSync(file) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Pack, sign and send one release to the feed's builder; answers what the builder answered. */
export async function contribute(request, privateKey, { fetchImpl = fetch } = {}) {
  if (typeof request.entries_url !== 'string' || !/^https:\/\/[^/]+\//.test(request.entries_url)) throw refuse('entries_url must be the https address of the feed builder\'s entry path (https://<builder>/engine-release-entry).', 2);
  const { entry, body } = await packAndSign(request, privateKey);
  const response = await fetchImpl(request.entries_url, {
    method: 'POST', body, headers: { 'content-type': 'application/gzip', [settings.entry_header]: entryHeader(entry) },
    signal: AbortSignal.timeout(settings.git_timeout_ms),
  });
  let answer = null;
  try { answer = await response.json(); } catch { /* not JSON */ }
  if (response.status !== 202 && response.status !== 200) throw refuse(`The feed's builder answered ${response.status}: ${answer?.error ?? 'no reason given'}.`);
  return { commit: entry.commit, sequence: entry.sequence, target: entry.target, content: entry.content, bytes: entry.bytes, public_key: publicKeyHex(privateKey), builder: answer };
}

/** A request read from its file, its paths resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(file, 'utf8')), here = dirname(file);
  for (const key of ['source', 'program']) if (typeof request[key] === 'string') request[key] = resolvePath(here, request[key]);
  return request;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, ...rest] = process.argv.slice(2);
  try {
    let answer;
    if (operation === 'contribute' && first && !rest.length) {
      const key = await privateInput(0);
      if (!key) throw refuse('Standard input holds no signing key: pipe it from the vault (a repository secret on a hosted runner).', 2);
      answer = await contribute(readRequest(resolvePath(first)), key);
    } else if (operation === 'public-key' && !first) {
      answer = { public_key: publicKeyHex(await privateInput(0)) };
    } else if (operation === 'make-key' && !first) {
      process.stdout.write(newSigningKey());
      process.exit(0);
    } else throw refuse('usage: contribute-an-engine-release.mjs contribute REQUEST_FILE | public-key | make-key (the signing key on standard input)', 2);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
