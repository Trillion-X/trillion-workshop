// tools/save-what-you-watch-and-read/do-work/browser-source.mjs
//
// Reads a person's saved X posts (their bookmarks or their likes), newest first, from their own signed-in X session:
// it opens X's list page in a Chromium-family browser that uses the browser profile folder the person signed in with,
// scrolls it, and keeps the answers X's own page asks for. It posts, likes, follows and changes nothing on X.
//
// Invariants:
//   - The session is only read: the browser profile is the person's, no cookie or token is printed or copied, and a
//     profile that is not signed in ends the run with that reason instead of an empty list.
//   - The browser this run started ends with the run.
//   - No answer from X's list within `seconds_to_first_page` is an error that names what was seen, never an empty result.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conventions, listFor } from './saved-source.mjs';
import { postsIn } from './x-posts.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));

/** Where a Chromium-family browser is on this computer: the request's own path, the named variables, then the usual places. */
export function findBrowser(asked) {
  const { browser } = conventions;
  if (asked) {
    if (!existsSync(asked)) throw new Error(`No browser at ${asked}. Give browser.executable as the path of a Chromium-family browser.`);
    return asked;
  }
  for (const name of browser.executable_env) if (process.env[name] && existsSync(process.env[name])) return process.env[name];
  for (const place of browser.executable_places) if (existsSync(place)) return place;
  for (const cache of browser.playwright_cache_places) {
    const folder = join(homedir(), cache.under_home);
    if (!existsSync(folder)) continue;
    const builds = readdirSync(folder).filter(name => name.startsWith(cache.folder_prefix) && /^\d+$/.test(name.slice(cache.folder_prefix.length)))
      .sort((a, b) => Number(b.slice(cache.folder_prefix.length)) - Number(a.slice(cache.folder_prefix.length)));
    for (const build of builds) for (const inside of cache.inside) if (existsSync(join(folder, build, inside))) return join(folder, build, inside);
  }
  throw new Error('No Chromium-family browser was found on this computer. Install Chrome or Chromium, or give browser.executable (its path).');
}

/** Starts the browser on the person's profile folder; answers its DevTools address and how to end it. */
function startBrowser(executable, profileDir) {
  const { browser } = conventions;
  const child = spawn(executable, [...browser.switches, '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const end = () => { try { child.kill('SIGKILL'); } catch { /* already ended */ } };
  process.once('exit', end);
  return new Promise((found, failed) => {
    let said = '';
    const timer = setTimeout(() => { end(); failed(new Error(`The browser did not start in ${browser.start_seconds} s: ${said.slice(-400)}`)); }, browser.start_seconds * 1000);
    child.stderr.on('data', chunk => {
      said += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (match) { clearTimeout(timer); found({ address: match[1], end }); }
    });
    child.on('error', error => { clearTimeout(timer); failed(new Error(`The browser ${executable} could not start: ${error.message}`)); });
    child.on('exit', code => { clearTimeout(timer); failed(new Error(`The browser stopped at start (exit ${code}); is the profile folder already open in another browser? ${said.slice(-300)}`)); });
  });
}

/** A DevTools connection: send(method, params, sessionId) answers the result; `listeners` hear every event. */
function connect(address) {
  const socket = new WebSocket(address);
  const waiting = new Map();
  const listeners = [];
  let next = 0;
  socket.onmessage = message => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && waiting.has(data.id)) {
      const { answer, fail } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) fail(new Error(`${data.error.message} (${data.error.code})`)); else answer(data.result);
    } else if (data.method) for (const listen of listeners) listen(data);
  };
  const send = (method, params = {}, sessionId) => new Promise((answer, fail) => {
    next += 1;
    const id = next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`The browser stopped answering (${method}).`)); }, conventions.browser.answer_seconds * 1000);
    waiting.set(id, { answer: value => { clearTimeout(timer); answer(value); }, fail: error => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const opened = new Promise((done, failed) => {
    socket.onopen = done;
    socket.onerror = () => failed(new Error(`The browser at ${address} refused the control connection.`));
  });
  return { send, listeners, opened, close: () => { try { socket.close(); } catch { /* already closed */ } } };
}

/**
 * Reads the list page. `onPage(posts)` is told each answer's posts and answers true when they held something new;
 * `onPage.finished()` answers true when the read has what it needs. Resolves with { pages, signedOut, at } when the
 * stop rules end it.
 */
async function readPages({ address, pageAddress, operation, onPage }) {
  const { scroll, stop } = conventions;
  const link = connect(address);
  await link.opened;
  try {
    const { targetId } = await link.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await link.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => link.send(method, params, sessionId);
    await page('Emulation.setDeviceMetricsOverride', { width: scroll.window.width, height: scroll.window.height, deviceScaleFactor: 1, mobile: false });
    await page('Network.enable');
    // X refuses a request whose browser name says it is headless; the browser is the person's own, so it gives its usual name.
    const { userAgent } = await link.send('Browser.getVersion');
    await page('Network.setUserAgentOverride', { userAgent: userAgent.replace(conventions.browser.headless_name, conventions.browser.usual_name) });
    const wanted = new Map();
    const pending = [];
    let pages = 0;
    let lastNew = Date.now();
    let enough = false;
    link.listeners.push(event => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Network.responseReceived' && operation.test(event.params.response.url)) wanted.set(event.params.requestId, true);
      if (event.method === 'Network.loadingFinished' && wanted.delete(event.params.requestId)) {
        pending.push(page('Network.getResponseBody', { requestId: event.params.requestId }).then(body => {
          const posts = postsIn(JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body));
          pages += 1;
          if (onPage(posts)) lastNew = Date.now();
          if (onPage.finished()) enough = true;
        }).catch(() => { /* a page body that is not a list answer is skipped */ }));
      }
    });
    const opened = await page('Page.navigate', { url: pageAddress });
    if (opened.errorText) throw new Error(`The browser could not open ${pageAddress}: ${opened.errorText}.`);
    const started = Date.now();
    const signedOut = new RegExp(conventions.signed_out_address_pattern);
    while (!enough && Date.now() - started < stop.minutes_at_most * 60000) {
      await wait(scroll.pause_ms);
      await Promise.all(pending.splice(0));
      if (pages === 0 && Date.now() - started > stop.seconds_to_first_page * 1000) {
        const where = await page('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => ({ result: { value: '' } }));
        return { pages, signedOut: signedOut.test(new URL(where.result.value || 'about:blank').pathname), at: where.result.value };
      }
      if (pages > 0 && Date.now() - lastNew > stop.seconds_without_new * 1000) break;
      await page('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 600, deltaX: 0, deltaY: scroll.wheel_pixels });
    }
    await Promise.all(pending.splice(0));
    return { pages, signedOut: false };
  } finally {
    link.close();
  }
}

/** The page a request's list is on and the request of it that carries the list. */
export function pageFor(request) {
  const kind = listFor(request);
  if (kind.needs && !request[kind.needs]) throw new Error(`${request.which} needs ${kind.needs}: the person's X name.`);
  return { pageAddress: kind.page.replace('{handle}', request.handle ?? ''), operation: new RegExp(kind.operation) };
}

/** Opens a visible window on X's sign-in page with the person's profile folder and waits until they close it. */
export function signIn(request) {
  const { browser, sign_in_page: page } = conventions;
  if (!request.profile_dir) throw new Error('profile_dir must be the browser profile folder to sign in to X with.');
  const executable = findBrowser(request.browser?.executable);
  const switches = browser.switches.filter(name => !name.startsWith('--headless'));
  const child = spawn(executable, [...switches, `--user-data-dir=${request.profile_dir}`, page], { stdio: 'ignore' });
  return new Promise((done, failed) => {
    child.on('error', error => failed(new Error(`The browser ${executable} could not start: ${error.message}`)));
    child.on('exit', () => done());
  });
}

/**
 * Reads the request's list from the person's signed-in X session in the browser profile folder `profile_dir`, feeding
 * `collected.onPage`; answers the number of pages read. A profile that is not signed in, or a page that never answers,
 * ends the run with that reason.
 */
export async function readFromBrowser(request, collected) {
  const { pageAddress, operation } = pageFor(request);
  if (!request.profile_dir || !existsSync(request.profile_dir)) throw new Error('profile_dir must be the browser profile folder the person signed in to X with.');
  const started = await startBrowser(findBrowser(request.browser?.executable), request.profile_dir);
  let outcome;
  try {
    outcome = await readPages({ address: started.address, pageAddress, operation, onPage: collected.onPage });
  } finally {
    started.end();
  }
  if (outcome.pages === 0) {
    throw new Error(outcome.signedOut
      ? 'X asked this browser profile to sign in. Sign in to X once in the profile folder, then run again.'
      : `X's list answered no page in ${conventions.stop.seconds_to_first_page} s (the page was at ${outcome.at || 'an unknown address'}).`);
  }
  return outcome.pages;
}
