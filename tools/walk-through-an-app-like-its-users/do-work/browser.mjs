// tools/walk-through-an-app-like-its-users/do-work/browser.mjs
//
// Pages in a Chromium-family browser, spoken to over the DevTools protocol through Node's own WebSocket, with no
// browser library: either a headless browser this run starts (and ends), or a page this run opens in a browser that
// is already listening (a person's own Chrome started with --remote-debugging-port, or Obscura's `obscura serve`).
//
// Invariants:
//   - A browser that does not start in `start_seconds`, or a call with no answer in `answer_seconds`, ends the run
//     with a message naming what stopped, instead of leaving it waiting.
//   - A browser this run started ends with the run and its throwaway profile folder is removed. A browser it only
//     attached to keeps running; only the pages and contexts this run opened are closed.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a browser is on this computer: the request's own path, then the named environment variables, then the usual places. */
export function findBrowser(conventions, asked) {
  if (asked) {
    if (!existsSync(asked)) throw new Error(`No browser at ${asked}. Give browser.executable as the path of a Chromium-family browser, or browser.devtools_address of one already listening.`);
    return asked;
  }
  for (const name of conventions.executable_env) if (process.env[name] && existsSync(process.env[name])) return process.env[name];
  for (const place of conventions.executable_places) if (existsSync(place)) return place;
  for (const cache of conventions.playwright_cache_places) {
    const folder = join(homedir(), cache.under_home);
    if (!existsSync(folder)) continue;
    const builds = readdirSync(folder).filter(name => name.startsWith(cache.folder_prefix) && /^\d+$/.test(name.slice(cache.folder_prefix.length)))
      .sort((a, b) => Number(b.slice(cache.folder_prefix.length)) - Number(a.slice(cache.folder_prefix.length)));
    for (const build of builds) for (const inside of cache.inside) if (existsSync(join(folder, build, inside))) return join(folder, build, inside);
  }
  throw new Error('No Chromium-family browser was found on this computer. Install Chrome or Chromium, or give browser.executable (its path) or browser.devtools_address (one already listening, such as `obscura serve`).');
}

function connect(address, answerSeconds) {
  const socket = new WebSocket(address);
  let next = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = message => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && waiting.has(data.id)) {
      const { answer, fail } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) fail(new Error(`${data.error.message} (${data.error.code})`)); else answer(data.result);
    } else if (data.method) for (const listen of listeners) listen(data);
  };
  socket.onclose = () => { for (const { fail } of waiting.values()) fail(new Error('The browser closed its control connection.')); waiting.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((answer, fail) => {
    next += 1;
    const id = next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`The browser stopped answering (${method}).`)); }, answerSeconds * 1000);
    waiting.set(id, { answer: value => { clearTimeout(timer); answer(value); }, fail: error => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const opened = new Promise((done, failed) => {
    socket.onopen = done;
    socket.onerror = () => failed(new Error(`The browser at ${address} refused the control connection.`));
  });
  return { socket, send, listeners, opened };
}

async function startBrowser(executable, conventions, window) {
  const profile = mkdtempSync(join(tmpdir(), 'walk-through-an-app-browser-'));
  const child = spawn(executable, [
    ...conventions.switches, '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${window.width},${window.height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const end = () => {
    try { child.kill('SIGKILL'); } catch { /* already ended */ }
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  process.once('exit', end);
  try {
    const address = await new Promise((found, failed) => {
      let said = '';
      const timer = setTimeout(() => failed(new Error(`The browser did not start in ${conventions.start_seconds} s: ${said.slice(-400)}`)), conventions.start_seconds * 1000);
      child.stderr.on('data', chunk => {
        said += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(said);
        if (match) { clearTimeout(timer); found(match[1]); }
      });
      child.on('error', error => { clearTimeout(timer); failed(new Error(`The browser ${executable} could not start: ${error.message}`)); });
      child.on('exit', code => { clearTimeout(timer); failed(new Error(`The browser stopped at start (exit ${code}): ${said.slice(-400)}`)); });
    });
    return { address, end: () => { process.removeListener('exit', end); end(); } };
  } catch (error) {
    process.removeListener('exit', end);
    end();
    throw error;
  }
}

async function attachedAddress(devtoolsAddress) {
  if (devtoolsAddress.startsWith('ws://') || devtoolsAddress.startsWith('wss://')) return devtoolsAddress;
  const answer = await fetch(new URL('/json/version', devtoolsAddress)).catch(error => { throw new Error(`Nothing answered at ${devtoolsAddress} (${error.message}). Start the browser with --remote-debugging-port, or run \`obscura serve\`.`); });
  const { webSocketDebuggerUrl } = await answer.json();
  if (!webSocketDebuggerUrl) throw new Error(`${devtoolsAddress} did not name its DevTools connection.`);
  return webSocketDebuggerUrl;
}

/**
 * Opens the browser. `asked` is the request's `browser` ({ executable?, devtools_address? }). Answers
 * { name, newPage(), close() }. `newPage()` opens a page in a context of its own (its own cookies and storage, so one
 * journey never inherits another's sign-in) and answers { send(method, params), on(listener), close() }: `send` calls
 * a DevTools method on the page, `on` hears its events, `close` ends the page and its context. `close()` ends what
 * this run started.
 */
export async function openBrowser(conventions, window, asked = {}) {
  let ending = () => {};
  let address;
  let name;
  if (asked.devtools_address) {
    address = await attachedAddress(asked.devtools_address);
    name = `attached:${asked.devtools_address}`;
  } else {
    const executable = findBrowser(conventions, asked.executable);
    const started = await startBrowser(executable, conventions, window);
    address = started.address;
    ending = started.end;
    name = executable;
  }
  const link = connect(address, conventions.answer_seconds);
  const close = () => {
    try { link.socket.close(); } catch { /* already closed */ }
    ending();
  };
  try {
    await link.opened;
  } catch (error) {
    close();
    throw error;
  }
  const newPage = async () => {
    const { browserContextId } = await link.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await link.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await link.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => link.send(method, params, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: window.width, height: window.height, deviceScaleFactor: 1, mobile: false });
    let closed = false;
    return {
      send,
      on: listen => link.listeners.push(data => { if (data.sessionId === sessionId) listen(data); }),
      close: async () => {
        if (closed) return;
        closed = true;
        await link.send('Target.closeTarget', { targetId }).catch(() => {});
        await link.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      },
    };
  };
  return { name, newPage, close };
}
