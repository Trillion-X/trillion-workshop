// Browser-side owner for trillion-rust tests/isolated_computer_fixture.rs's explicitly started synthetic process.
// The caller supplies a freshly qualified test binary; this module never searches old build output or installed accounts.
// Old trillion: scripts/passkey-account.mjs:1 made live disposable accounts. This fixture owns only a temporary Computer.
// Obscura's actual CDP probe refused WebAuthn.enable (Unknown domain: WebAuthn); Chromium supplies that missing API.
// Browser requests go only to this fixture's origin via strict Node TLS with its own fresh CA. No TLS checks are disabled.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import https from 'node:https';

const prefix = 'TRILLION_ISOLATED_FIXTURE ';
const timeout = (promise, ms, words) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(words)), ms); })])
    .finally(() => clearTimeout(timer));
};

/** Strict HTTPS, one exact owned origin, no redirects. Response data is kept only in memory. */
export function fixtureRequest(origin, ca, { maximumBytes = 65_536, timeoutMs = 30_000 } = {}) {
  const expected = new URL(origin);
  if (expected.protocol !== 'https:' || expected.hostname !== 'localhost' || !expected.port || expected.pathname !== '/'
    || expected.username || expected.password || expected.search || expected.hash) {
    throw new Error('The isolated Computer must name one HTTPS localhost origin.');
  }
  return (url, init = {}) => new Promise((resolveReply, reject) => {
    const target = new URL(url);
    if (target.origin !== expected.origin || target.username || target.password) {
      reject(new Error('The fixture transport refused another origin.')); return;
    }
    const headers = { ...init.headers };
    for (const name of Object.keys(headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) delete headers[name];
    }
    const request = https.request(target, {
      method: init.method ?? 'GET', headers, ca, rejectUnauthorized: true, servername: expected.hostname,
      timeout: timeoutMs, signal: init.signal,
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maximumBytes) { response.destroy(new Error('The fixture reply exceeded its bound.')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('The isolated Computer reply could not be read.')));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join('\n') : String(value ?? '')]));
        resolveReply({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
          headers, bytes, text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')) });
      });
    });
    request.on('timeout', () => request.destroy(new Error('The isolated Computer request timed out.')));
    request.on('error', () => reject(new Error('The isolated Computer TLS request failed.')));
    request.end(init.body ?? undefined);
  });
}

/**
 * fixtureBinary must be the current source test executable selected by the contained Cargo owner. rustRoot is the
 * current Rust checkout whose synthetic product settings it uses. A caller may supply launchBrowser for focused
 * producer tests; ordinary use starts a new Chromium browser with no saved profile or session.
 */
export async function startIsolatedProofComputer({ fixtureBinary, rustRoot, launchBrowser, timeoutMs = 30_000 } = {}) {
  if (!isAbsolute(fixtureBinary ?? '') || !isAbsolute(rustRoot ?? '') || !(await stat(fixtureBinary)).isFile()) {
    throw new Error('Supply the qualified isolated Computer test executable and current Rust checkout.');
  }
  const env = { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    PRODUCT_SETTINGS: resolve(rustRoot, 'tests/fixtures/product-settings.json') };
  const child = spawn(fixtureBinary, ['--exact', 'owned_browser_fixture', '--ignored', '--nocapture', '--test-threads=1'], {
    cwd: rustRoot, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited, exitSeen = false, buffer = '', bytes = 0, nextId = 0, browser, context, closing, closedEvidence;
  const waiting = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const exit = new Promise(resolveExit => {
    child.once('error', () => { readyReject(new Error('The isolated Computer process could not start.')); });
    child.once('close', (code, signal) => {
      exitSeen = true; exited = { code, signal }; resolveExit(exited);
      readyReject(new Error('The isolated Computer exited before readiness.'));
      for (const waiter of waiting.values()) waiter.reject(new Error('The isolated Computer exited during control.'));
      waiting.clear();
    });
  });
  child.stderr.resume(); // Product diagnostics can name internal state; never print them or a request body here.
  child.stdin.on('error', () => {}); // A concurrent process exit is reported by close/control, never an uncaught EPIPE.
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 262_144) { readyReject(new Error('The isolated Computer control output exceeded its bound.')); child.stdin.end(); return; }
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const start = line.indexOf(prefix);
      if (start < 0) continue; // libtest's own bounded headings precede the protocol prefix.
      let answer;
      try { answer = JSON.parse(line.slice(start + prefix.length)); } catch { readyReject(new Error('The fixture control reply was invalid.')); continue; }
      if (answer.event === 'ready') readyResolve(answer);
      else if (waiting.has(answer.id)) {
        const waiter = waiting.get(answer.id); waiting.delete(answer.id);
        if (answer.error) waiter.reject(new Error('The isolated Computer refused fixture control.'));
        else waiter.resolve(answer.result);
      }
    }
  });
  const command = async input => {
    if (exitSeen) throw new Error('The isolated Computer is no longer running.');
    const id = ++nextId;
    const answer = new Promise((resolveAnswer, rejectAnswer) => waiting.set(id, { resolve: resolveAnswer, reject: rejectAnswer }));
    child.stdin.write(`${JSON.stringify({ id, ...input })}\n`);
    try { return await timeout(answer, timeoutMs, 'The isolated Computer control request timed out.'); }
    finally { waiting.delete(id); }
  };
  const close = () => closing ??= (async () => {
    let failure;
    try { await context?.close(); } catch { failure = new Error('The fixture browser did not close.'); }
    try { await browser?.close(); } catch { failure = new Error('The fixture browser did not close.'); }
    let acknowledgement;
    try {
      if (!exitSeen) acknowledgement = await command({ method: 'close' });
      child.stdin.end();
      const ended = await timeout(exit, timeoutMs, 'The isolated Computer did not exit after close.');
      if (ended.code !== 0 || acknowledgement?.closed !== true || acknowledgement.listener_closed !== true
        || acknowledgement.temporary_root_removed !== true) throw new Error('The isolated Computer teardown was not verified.');
      closedEvidence = acknowledgement;
    } catch {
      child.stdin.end(); child.kill('SIGTERM');
      try { await timeout(exit, timeoutMs, 'The owned fixture process did not stop.'); } catch { /* Preserve failed verification. */ }
      failure = new Error('The isolated Computer teardown was not verified.');
    }
    if (failure) throw failure;
    return closedEvidence;
  })();
  try {
    const found = await timeout(ready, timeoutMs, 'The isolated Computer did not become ready.');
    if (found.version !== 1 || found.pid !== child.pid || typeof found.ca_pem !== 'string'
      || !found.ca_pem.startsWith(`-----BEGIN ${'CERTIFICATE'}-----`)) throw new Error('The fixture readiness reply was invalid.');
    const request = fixtureRequest(found.origin, found.ca_pem, { timeoutMs });
    browser = launchBrowser ? await launchBrowser()
      : await (await import('trillion-workshop/tools/headless-browser/test/workshop-browser-for-tests.mjs')).launchChromium({
        headless: true, timeout: timeoutMs, admission: { timeoutMs },
      });
    context = await browser.newContext();
    await context.route('**/*', async route => {
      const incoming = route.request();
      if (new URL(incoming.url()).origin !== found.origin) { await route.abort('blockedbyclient').catch(() => {}); return; }
      try {
        const reply = await request(incoming.url(), { method: incoming.method(), headers: await incoming.allHeaders(), body: incoming.postDataBuffer() });
        await route.fulfill({ status: reply.status, headers: reply.headers, body: reply.bytes });
      } catch { await route.abort('failed').catch(() => {}); }
    });
    const page = await context.newPage();
    return { isolated: true, origin: found.origin, page, request, close,
      readCreatedAccount: address => command({ method: 'read-created-account', address }),
      get closedEvidence() { return closedEvidence; } };
  } catch {
    try { await close(); } catch { /* The fixed failure below never claims successful cleanup. */ }
    throw new Error('The isolated Computer/browser fixture could not start.');
  }
}
