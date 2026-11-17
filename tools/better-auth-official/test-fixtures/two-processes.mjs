// Two Better Auth processes on one store, the way two computers behind the sign-in name run: the same base URL, issuer and secret,
// each on its own loopback port, both sending mail to one stand-in sender and both reading and writing the one Postgres database
// `store.database()` made.
// `a` and `b` answer by `call(process, path under the base path, { body, form, cookie })`; the origin header is the shared base URL, as a browser's is.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStandInSender } from './stand-in-sender.mjs';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const tool = new URL('..', import.meta.url).pathname;
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
export const SECRET = 'a-scratch-secret-for-this-test-only-0123456789';

export async function startTwoProcesses(connection, overrides = {}) {
  const home = await freePort();
  const base = {
    ...shipped, base_url: `http://localhost:${home}`, issuer: `http://localhost:${home}`, audience: `http://localhost:${home}`,
    trusted_origins: [`http://localhost:${home}`], email_password: { require_verification: false }, disabled_paths: [], rate_limit: { enabled: false },
    ...overrides,
  };
  const sender = await startStandInSender();
  const dir = mkdtempSync(join(tmpdir(), 'two-processes-'));
  const processes = [];
  for (const name of ['a', 'b']) {
    const [port, internal] = [await freePort(), await freePort()];
    const settings = { ...base, port, email: sender.email, internal: { ...base.internal, port: internal } };
    const file = join(dir, `${name}-settings.json`);
    writeFileSync(file, JSON.stringify(settings));
    const env = { ...process.env, BETTER_AUTH_SETTINGS: file, BETTER_AUTH_SECRET: SECRET, CREDENTIALS_DIRECTORY: sender.credentials, [settings.store.env]: connection };
    const child = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    processes.push({ name, port, settings, child, dir });
  }
  // Both start together, so the second finds the first making the tables (store.mjs holds them to one at a time).
  await Promise.all(processes.map(p => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${p.name} did not listen`)), 60000);
    p.child.stdout.on('data', function wait(chunk) { if (/better-auth internal/.test(String(chunk))) { clearTimeout(timer); p.child.stdout.off('data', wait); done(); } });
    p.child.on('exit', code => fail(new Error(`${p.name} exited ${code}`)));
  })));
  const [a, b] = processes;
  const origin = base.base_url;
  const call = (p, path, { body, form, cookie, method } = {}) => fetch(`http://127.0.0.1:${p.port}${base.base_path}${path}`, {
    method: method ?? (body || form ? 'POST' : 'GET'),
    headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const mail = sender.mail;
  return { a, b, call, mail, settings: base, origin, stop: () => { processes.forEach(p => p.child.kill()); sender.stop(); } };
}

export const cookieOf = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
