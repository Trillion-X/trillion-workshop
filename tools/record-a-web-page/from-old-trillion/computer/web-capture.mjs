// computer/web-capture.mjs
//
// PURPOSE
//   The way a person (or their AI) uses the capture proxy (computer/capture-proxy.mjs) from the Mac host: start it as a process of
//   its own on a loopback port, say where to point a program, read what it kept, ask for the authority to be trusted, and stop it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One proxy at a time per Mac. Its process is this host's child and ends with the host (end-with-the-app semantics: a stop
//      signal when the host exits), so capture never keeps running unseen.
//   2. Nothing here trusts the authority: `trust` runs the system's own prompt (capture-ca.mjs trust()).
//   3. What is read back is only what the proxy kept: its redaction and body cut are the proxy's DATA, not this file's.
//   4. Blind: no site or program is named here.
//
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCaptureCa } from './capture-ca.mjs';
import { captureProxySettings } from './capture-proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });
const ACTIONS = ['start', 'stop', 'status', 'read', 'clear', 'trust'];

export function makeWebCapture({ home = homedir(), settings = captureProxySettings(), spawnImpl = spawn, startSeconds = 20 } = {}) {
  let child = null;
  let facts = null;
  const file = join(home, settings.captures_file);
  const status = () => (child && child.exitCode === null ? { running: true, ...facts } : { running: false });

  async function start() {
    if (child && child.exitCode === null) return { ...status(), said: 'Capture is already running.' };
    child = spawnImpl(process.execPath, [join(HERE, 'capture-proxy.mjs'), 'serve'], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    const started = await new Promise((done, fail) => {
      let text = '';
      const timer = setTimeout(() => fail(refusal(`The capture proxy did not start in ${startSeconds} seconds.`, 504)), startSeconds * 1000);
      child.on('exit', code => { clearTimeout(timer); fail(refusal(`The capture proxy stopped while starting (${code}).`, 502)); });
      child.stdout.on('data', piece => {
        text += piece;
        for (const line of text.split('\n').slice(0, -1)) { try { lines.push(JSON.parse(line)); } catch { /* not a status line */ } }
        text = text.slice(text.lastIndexOf('\n') + 1);
        const listening = lines.find(item => item.listening);
        if (listening) { clearTimeout(timer); done({ ...listening, authority: lines.find(item => item.state) ?? null }); }
      });
    }).catch(error => { child?.kill(); child = null; throw error; });
    facts = started;
    return { ...status(), said: `Point a program at ${started.listening}. Its secure traffic can be read only if you trust the authority at ${started.certificate}.` };
  }

  return {
    start,
    stop() {
      const had = Boolean(child && child.exitCode === null);
      child?.kill('SIGTERM');
      child = null; facts = null;
      return { running: false, stopped: had, said: had ? 'Capture stopped.' : 'Capture was not running.' };
    },
    status,
    read({ limit = 50 } = {}) {
      if (!existsSync(file)) return { exchanges: [], said: 'Nothing has been captured.' };
      const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, Number(limit) || 50)));
      return { exchanges: rows.map(row => JSON.parse(row)) };
    },
    clear() {
      if (existsSync(file)) truncateSync(file, 0);
      return { cleared: true, said: 'The captured exchanges were cleared.' };
    },
    trust() {
      makeCaptureCa({ home }).trust();
      return { said: 'The system asked you whether to trust the capture authority.' };
    },
  };
}

let shared = null;
const captureHere = () => {
  if (!shared) { shared = makeWebCapture(); process.once('exit', () => shared.stop()); }
  return shared;
};
/** One tool for web capture: { action: start | stop | status | read | clear | trust, limit? }. */
async function capture({ action = 'status', ...input } = {}) {
  if (!ACTIONS.includes(action)) throw refusal(`There is no capture action named ${action}. Use ${ACTIONS.join(', ')}.`);
  return captureHere()[action](input);
}
export const captureTools = { capture };
