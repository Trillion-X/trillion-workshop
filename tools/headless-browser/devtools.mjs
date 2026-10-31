// tools/headless-browser/devtools.mjs
//
// Starts a headless Chromium and speaks to its first page over the DevTools protocol through a pipe (--remote-debugging-pipe:
// the browser reads descriptor 3 and writes descriptor 4, one JSON message ended by a NUL byte each), with no browser
// library and no TCP port, so a script can run the same way on a person's computer and in a Workshop container or a
// sandbox that lets a browser listen on nothing.
//
// Invariants:
//   - Every Chromium starts with this part's quiet switches first (quiet-switches.json).
//   - A browser that does not answer its first call in 30 s, or a DevTools call with no answer in 60 s, ends with a BrowserProblem
//     naming what stopped, instead of leaving the run waiting for hours.
//   - However the calling run ends, the browser process ends with it and its throwaway profile folder is removed.
//   - How many browsers may run at once on a computer is the runner's to decide, not this file's: a tool opens one
//     browser when it is run.
//   - A run told a proxy (HTTPS_PROXY, as the engine tells every internet:true run) sends the browser's traffic through
//     it (--proxy-server), loopback addresses included (--proxy-bypass-list=<-loopback>, since Chromium would
//     otherwise go direct to them): Chromium does not read that setting itself, and the engine's sandbox lets the run
//     reach nothing else. Which addresses are public is the engine's to judge, never this file's.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const quietSwitches = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'quiet-switches.json'), 'utf8')).switches;

const places = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-places.json'), 'utf8')).places;

/** The files a place names: one file, or (with * in a folder name) every match, highest name first. */
function expand(place, home) {
  let paths = [place.startsWith('~/') ? join(home, place.slice(2)) : place];
  while (paths.some(path => path.includes('*'))) {
    paths = paths.flatMap(path => {
      const star = path.indexOf('*');
      if (star < 0) return [path];
      const folder = path.slice(0, path.lastIndexOf('/', star));
      const part = path.slice(folder.length + 1).split('/')[0];
      const rest = path.slice(folder.length + 1 + part.length);
      const pattern = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      let names = [];
      try { names = readdirSync(folder).filter(name => pattern.test(name)).sort().reverse(); } catch { /* no such folder */ }
      return names.map(name => join(folder, name) + rest);
    });
  }
  return paths;
}

/**
 * The browser program to start. A path (any name with a folder in it) is used as given; a bare name such as
 * `chromium`, or none, is looked for in browser-places.json on this computer.
 */
export function browserExecutable(executable, home = userInfo().homedir) {
  if (executable && executable.includes('/')) return executable;
  for (const place of places) {
    for (const path of expand(place, home)) {
      try { if (existsSync(path)) { accessSync(path, constants.X_OK); return path; } } catch { /* not runnable */ }
    }
  }
  throw new BrowserProblem('No browser was found on this computer. Install Chrome, Chromium, Edge or Brave, or name one with --browser or BROWSER_EXECUTABLE.');
}

/** A problem the person running the script can act on; its message is shown as it is. */
export class BrowserProblem extends Error {}

/** Attach to the browser's existing page, or explicitly create one when startup has not made a target yet. */
export async function attachPageTarget(send) {
  const { targetInfos = [] } = await send('Target.getTargets');
  let page = targetInfos.find(target => target.type === 'page');
  if (!page) {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    if (!created?.targetId) throw new BrowserProblem('The browser did not create a page target.');
    page = { targetId: created.targetId };
  }
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  if (!attached?.sessionId) throw new BrowserProblem('The browser did not attach to its page target.');
  return { targetId: page.targetId, sessionId: attached.sessionId };
}

/**
 * Opens a headless Chromium at `executable` with a window of `width` x `height` and attaches to its page. `switches` are further
 * command-line switches after the quiet ones (a virtual-clock recording asks for deterministic-switches.json).
 * Answers { send(method, params), on(listener), close() }: `send` calls a DevTools method on the page, `on` hears
 * the page's events, `close` ends the browser.
 */
export async function openBrowser(executable, { width, height, switches = [] } = {}) {
  let profile;
  let child;
  let killAtExit;
  try {
  executable = browserExecutable(executable);
  profile = mkdtempSync(join(tmpdir(), 'headless-browser-'));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  child = spawn(executable, [
    ...quietSwitches, ...switches, ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>'] : []), '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--disable-dev-shm-usage', '--force-color-profile=srgb', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  // However this run ends, even before the browser answered, the browser ends with it.
  killAtExit = () => { try { child.kill('SIGKILL'); } catch { /* process already exited */ } };
  process.once('exit', killAtExit);
  child.once('exit', () => {
    if (killAtExit) process.removeListener('exit', killAtExit);
  });
  // What the browser said on its error output before it answered, for the words of a start that failed.
  let said = '';
  child.stderr.on('data', chunk => { said = (said + chunk).slice(-4000); });
  let next = 0;
  const waiting = new Map();
  const listeners = [];
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let ended = null;
  const failAll = problem => {
    ended ??= problem;
    for (const { fail } of waiting.values()) fail(problem);
    waiting.clear();
  };
  // The browser's messages arrive in pieces; each ends at a NUL byte.
  let heard = '';
  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', chunk => {
    heard += chunk;
    for (let end = heard.indexOf('\0'); end >= 0; end = heard.indexOf('\0')) {
      const text = heard.slice(0, end);
      heard = heard.slice(end + 1);
      if (!text) continue;
      const data = JSON.parse(text);
      if (data.id !== undefined && waiting.has(data.id)) {
        const { answer, fail } = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) fail(new Error(`${data.error.message} (${data.error.code})`)); else answer(data.result);
      } else if (data.method) for (const listen of listeners) listen(data);
    }
  });
  fromBrowser.on('error', () => { /* the browser ended; its exit says why */ });
  toBrowser.on('error', () => { /* the browser ended; its exit says why */ });
  child.once('error', error => failAll(new BrowserProblem(`The browser ${executable} could not start: ${error.message}`)));
  child.once('exit', code => failAll(new BrowserProblem(`The browser stopped (exit ${code}): ${said.slice(-400)}`)));
  // A browser that stops answering ends the run (and the caller's finally closes it) instead of leaving it open for hours.
  // Its first call may wait for the browser to start, so it is given 30 s.
  const send = (method, params = {}, sessionId, seconds = 60) => new Promise((answer, fail) => {
    if (ended) { fail(ended); return; }
    next += 1;
    const id = next;
    const timer = setTimeout(() => {
      waiting.delete(id);
      fail(new BrowserProblem(seconds === 30 ? `The browser did not start: ${said.slice(-400)}` : `The browser stopped answering (${method}).`));
    }, seconds * 1000);
    waiting.set(id, { answer: value => { clearTimeout(timer); answer(value); }, fail: error => { clearTimeout(timer); fail(error); } });
    toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const { sessionId } = await attachPageTarget((method, params) => send(method, params, undefined, method === 'Target.getTargets' ? 30 : 60));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { toBrowser.destroy(); fromBrowser.destroy(); } catch { /* already closed */ }
    child.kill('SIGKILL');
    // The killed browser may still be writing its profile for a moment, so removing it retries briefly.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return {
    send: (method, params) => send(method, params, sessionId),
    on: listen => listeners.push(data => { if (data.sessionId === sessionId) listen(data); }),
    close,
  };
  } catch (error) {
    if (killAtExit) process.removeListener('exit', killAtExit);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}
