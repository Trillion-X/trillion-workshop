// tools/publish-an-engine-release/do-work/receive-pushes.mjs
//
// The push receiver install runs as a service on the builder: GitHub sends each push to `push_path` (Caddy passes it
// to 127.0.0.1:`receiver_port`); a delivery whose X-Hub-Signature-256 is the HMAC-SHA256 of its body under the push
// secret, for the configured branch, runs publish for the pushed commit. Runs go one at a time; while one runs, only
// the newest push waits (an older one would be refused by the feed anyway). The answer is 202 at once, because
// GitHub gives up on a delivery after ten seconds; how each run went is in the state folder's last-run.json.
//
// When the config names `accept_entries_from`, it also takes other builders' signed releases (one builder per target
// it builds for) at `entry_path`: the entry in a header, checked against those keys before the body is read, the
// tar.gz as the body; each target has its own queue, and `accept` (publish-an-engine-release.mjs) adds it to the feed.
//
// The repository token arrives on descriptor 3 and the push secret on descriptor 4 (the service opens them from its
// systemd credentials); both are read once and kept in memory only. The token reaches publish on its descriptor 3.
//
// usage: receive-pushes.mjs serve CONFIG_FILE
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateInput, readRequest, writeAtomically } from './publish-an-engine-release.mjs';
import { checkTarget, settings, signerOf } from './release-feed.mjs';
import { readEntryHeader } from './contribute-an-engine-release.mjs';

const PUBLISH = fileURLToPath(new URL('./publish-an-engine-release.mjs', import.meta.url));

/** Whether `header` (sha256=<hex>) is the body's HMAC under the secret, compared in constant time. */
export function signatureHolds(secret, body, header) {
  if (!secret || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(want, Buffer.from(header.slice(7), 'hex'));
}

/** What a delivery asks for: `{ commit }` to publish, or `{ ignored }` with why. */
export function readDelivery(event, body, branch) {
  if (event === 'ping') return { ignored: 'ping' };
  if (event !== 'push') return { ignored: `a ${event ?? 'nameless'} event is not a push` };
  let push;
  try { push = JSON.parse(body.toString('utf8')); } catch { return { refused: 'the delivery is not JSON: set the webhook content type to application/json' }; }
  if (push.ref !== `refs/heads/${branch}`) return { ignored: `a push to ${push.ref}, not ${branch}` };
  if (push.deleted) return { ignored: 'the branch was deleted' };
  if (typeof push.after !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(push.after)) return { refused: 'the push names no commit' };
  return { commit: push.after };
}

/** One run at a time; while it runs only the newest asked commit waits. */
export function makeQueue(runOne) {
  let running = null, waiting = null;
  const next = () => {
    if (running || !waiting) return running;
    const commit = waiting;
    waiting = null;
    running = Promise.resolve().then(() => runOne(commit)).catch(() => {}).finally(() => { running = null; next(); });
    return running;
  };
  return { ask(commit) { waiting = commit; return next(); }, running: () => running };
}

/** Run publish for one commit as a child, its token on the child's descriptor 3; answers what it printed last. */
export function runPublish({ configFile, token, stateFolder, node = process.execPath, publishFile = PUBLISH, log = line => process.stdout.write(`${line}\n`) }) {
  return commit => new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawn(node, [publishFile, 'publish', configFile, '--commit', commit], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out = (out + bytes).slice(-65536); });
    child.stderr.on('data', bytes => { err = (err + bytes).slice(-8192); });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(token);
    child.on('close', code => {
      let answer = null;
      try { answer = JSON.parse(out.trim().split('\n').at(-1)); } catch { /* nothing printed */ }
      // A run that published one target and failed another (exit 4: a Mac target, publish-an-engine-release.mjs
      // `also`) keeps both: the release it published and what failed.
      const failed = (answer?.also ?? []).filter(one => one.error).map(one => `${one.target}: ${one.error}`).join(' | ');
      const run = { commit, started_at: started, finished_at: new Date().toISOString(), exit: code, ...(answer?.commit ? { release: answer } : {}), ...(code === 0 ? {} : { error: answer?.error ?? (failed || (err.trim().split('\n').at(-1) ?? null)) }) };
      try { mkdirSync(stateFolder, { recursive: true }); writeAtomically(join(stateFolder, 'last-run.json'), `${JSON.stringify(run, null, 1)}\n`); } catch (error) { log(`could not write last-run.json: ${error.message}`); }
      log(code === 0 ? `published ${commit} (sequence ${answer?.sequence}, ${[answer?.target, ...(answer?.also ?? []).map(one => one.target)].join(', ')}${answer?.already_published ? ', already in the feed' : ''})` : `publish ${commit} failed: ${run.error}`);
      resolve(run);
    });
  });
}

/** Run accept for one offered entry as a child, its token on the child's descriptor 3; keeps how it went in
 *  last-entry-<target>.json beside last-run.json. The entry and body files are removed after. */
export function runAccept({ configFile, token, stateFolder, node = process.execPath, publishFile = PUBLISH, log = line => process.stdout.write(`${line}\n`) }) {
  return ({ target, entryFile, bodyFile, commit }) => new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawn(node, [publishFile, 'accept', configFile, entryFile, bodyFile], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out = (out + bytes).slice(-65536); });
    child.stderr.on('data', bytes => { err = (err + bytes).slice(-8192); });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(token);
    child.on('close', code => {
      let answer = null;
      try { answer = JSON.parse(out.trim().split('\n').at(-1)); } catch { /* nothing printed */ }
      const run = { commit, target, started_at: started, finished_at: new Date().toISOString(), exit: code, ...(code === 0 ? { release: answer } : { error: answer?.error ?? err.trim().split('\n').at(-1) ?? null }) };
      rmSync(entryFile, { force: true });
      rmSync(bodyFile, { force: true });
      try { writeAtomically(join(stateFolder, `last-entry-${target}.json`), `${JSON.stringify(run, null, 1)}\n`); } catch (error) { log(`could not write last-entry-${target}.json: ${error.message}`); }
      log(code === 0 ? `accepted ${commit} for ${target}${answer?.already_published ? ' (already in the feed)' : ''}` : `accept ${commit} for ${target} failed: ${run.error}`);
      resolve(run);
    });
  });
}

/** One queue per target (`makeQueue` each): an entry for one target never waits behind another target's. A
 *  replaced waiting entry's files are removed. */
export function makeTargetQueues(runOne) {
  const queues = new Map(), waiting = new Map();
  return {
    ask(offer) {
      const before = waiting.get(offer.target);
      if (before) { rmSync(before.entryFile, { force: true }); rmSync(before.bodyFile, { force: true }); }
      waiting.set(offer.target, offer);
      if (!queues.has(offer.target)) queues.set(offer.target, makeQueue(one => { if (waiting.get(one.target) === one) waiting.delete(one.target); return runOne(one); }));
      return queues.get(offer.target).ask(offer);
    },
  };
}

/** What an entry delivery's header offers: `{ entry, target }`, or `{ status, error }` when it is refused before its
 *  body is read (no entry, a target that is not a triple, or a signature by no key the builder accepts). */
export function readOffer(header, accepted) {
  const entry = readEntryHeader(header);
  if (!entry) return { status: 400, error: `the ${settings.entry_header} header must be the entry as base64 JSON` };
  let target;
  try { target = checkTarget(entry.target); } catch (error) { return { status: 400, error: error.message }; }
  if (!signerOf({ ...entry, url: undefined }, accepted)) return { status: 401, error: 'release_signature_refused: the entry is not signed by a key this builder accepts' };
  return { entry, target };
}

/** The receiver: an HTTP server that checks each delivery and queues its commit; and, when `entries` is given, takes
 *  other builders' signed entries at `entries.path` and queues them per target. */
export function makeReceiver({ secret, branch, path, queue, log = () => {}, entries = null }) {
  return createServer((request, response) => {
    const answer = (status, said) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(`${JSON.stringify(said)}\n`); };
    if (entries && request.method === 'POST' && (request.url ?? '').split('?')[0] === entries.path) return takeEntry(request, answer, entries, log);
    if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== path) return answer(404, { error: `deliveries go to POST ${path}` });
    const chunks = [];
    let size = 0, over = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > settings.push_body_bytes_at_most) { over = true; request.destroy(); } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      if (!signatureHolds(secret, body, request.headers['x-hub-signature-256'])) { log('a delivery was refused: its signature does not hold'); return answer(401, { error: 'the signature does not hold: the webhook secret must be the push secret install was given' }); }
      const asked = readDelivery(request.headers['x-github-event'], body, branch);
      if (asked.refused) return answer(400, { error: asked.refused });
      if (asked.ignored) return answer(200, { ignored: asked.ignored });
      log(`push to ${branch}: ${asked.commit}`);
      queue.ask(asked.commit);
      return answer(202, { queued: asked.commit });
    });
    request.on('close', () => { if (over && !response.headersSent) answer(413, { error: 'the delivery is larger than a push may be' }); });
  });
}

/** One entry delivery: its header checked first, then its body read (bounded) into the state folder and queued. */
function takeEntry(request, answer, { accepted, folder, queue }, log) {
  const offer = readOffer(request.headers[settings.entry_header], accepted);
  if (offer.error) { request.resume(); log(`an entry was refused: ${offer.error}`); return answer(offer.status, { error: offer.error }); }
  const declared = Number(request.headers['content-length']);
  if (declared > settings.entry_body_bytes_at_most) { request.resume(); return answer(413, { error: 'the body is larger than a release may be' }); }
  const chunks = [];
  let size = 0, over = false;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > settings.entry_body_bytes_at_most) { over = true; request.destroy(); } else chunks.push(chunk);
  });
  request.on('end', () => {
    if (over) return;
    const stem = join(folder, `${offer.target}.${offer.entry.commit}.${process.hrtime.bigint()}`);
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(`${stem}.part`, Buffer.concat(chunks), { mode: 0o600 });
      renameSync(`${stem}.part`, `${stem}.tar.gz`);
      writeFileSync(`${stem}.json`, JSON.stringify(offer.entry), { mode: 0o600 });
    } catch (error) { return answer(500, { error: `the entry could not be kept: ${error.message}` }); }
    log(`entry for ${offer.target}: ${offer.entry.commit}`);
    queue.ask({ target: offer.target, commit: offer.entry.commit, entryFile: `${stem}.json`, bodyFile: `${stem}.tar.gz` });
    return answer(202, { queued: offer.entry.commit, target: offer.target });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, configFile, ...rest] = process.argv.slice(2);
  try {
    if (operation !== 'serve' || !configFile || rest.length) throw Object.assign(new Error('usage: receive-pushes.mjs serve CONFIG_FILE (repository token on fd 3, push secret on fd 4)'), { exit: 2 });
    const config = readRequest(resolvePath(configFile));
    const token = await privateInput(3), secret = await privateInput(4);
    if (!secret) throw new Error('Descriptor 4 holds no push secret: install stores it; run install again with the secret on descriptor 4.');
    const log = line => process.stdout.write(`${line}\n`);
    const queue = makeQueue(runPublish({ configFile: resolvePath(configFile), token, stateFolder: config.state_folder, log }));
    const [host, port] = [config.receiver?.host ?? '127.0.0.1', config.receiver?.port ?? settings.receiver_port];
    const accepted = config.accept_entries_from ?? [];
    const entries = accepted.length ? {
      accepted, path: config.receiver?.entry_path ?? settings.entry_path, folder: join(config.state_folder, 'entries'),
      queue: makeTargetQueues(runAccept({ configFile: resolvePath(configFile), token, stateFolder: config.state_folder, log })),
    } : null;
    makeReceiver({ secret, branch: config.branch, path: config.receiver?.path ?? settings.push_path, queue, log, entries }).listen(port, host, () => log(`receiving pushes to ${config.branch} on ${host}:${port}`));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
