// computer/open-from-web.mjs
//
// Purpose
//   Lets the Trillion page in a person's browser open what it shows in the Trillion Mac app: the page asks this
//   computer's own listener whether the app is here (GET /hello) and, if so, hands it a path (POST /open), which goes to
//   the app's menu bar panel as the trillion://panel address it already takes. The listener answers only the Trillion
//   origin, only on this computer, and only for paths of a Trillion screen.
//
// Non-negotiable invariants
//   1. Who may ask, which paths, the port, the words and the delivery wait are DATA (computer/open-from-web.json); this
//      file names none. `enabled` false opens no listener.
//   2. A request is answered only when its Origin is exactly one of `allowed_origins` and its Host is this listener's
//      own (a name that resolves elsewhere, DNS rebinding, is refused); a preflight carries the private-network answer
//      browsers ask before a public page talks to this computer. Origin is advisory against other programs here, so
//      what a request can do is limited to opening a Trillion screen: the path is checked before anything runs.
//   3. The program that opens the address is run with an argument array (never a shell string; F-0062), the address
//      being one word.
//   4. The address is handed to the app until the app says it took it (computer/deliver-until-acknowledged.mjs), a
//      bounded number of times; the answer says whether it was. The app says so by calling back with the one-time id
//      the address carried and its bundle id in a header a web page cannot send; an id nobody is waiting for is refused.
//   5. A listener that cannot bind (another helper holds the port) says so in the log and answers nothing; it never
//      takes the port by force.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deliverUntilAcknowledged } from './deliver-until-acknowledged.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const runFile = promisify(execFile);
export const openFromWebSettings = () => JSON.parse(readFileSync(join(HERE, 'open-from-web.json'), 'utf8'));
const fill = (words, values) => words.map(word => word.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole));

/** The path as a screen this computer may open, or null. */
export function openablePath(path, settings) {
  if (typeof path !== 'string' || path.length < 2 || path.length > settings.most_path_characters || !path.startsWith('/')) return null;
  if (!new RegExp(`^[${settings.path_characters}]+$`).test(path) || path.includes('//') || path.split(/[/?#]/)[0] !== '' || /(^|\/)\.\.?(\/|$|\?|#)/.test(path) || /%(?:[01][0-9a-f]|7f|2e|2f|5c)/i.test(path)) return null;
  return settings.open_folders.includes(path.slice(1).split(/[/?#]/)[0]) ? path : null;
}

// The ids of addresses handed to the app that it has not yet said it took, and those it has.
const waiting = new Set();
const taken = new Set();
/** Records that the app took the address with this id; false when nobody is waiting for that id. */
export function acknowledge(id) {
  if (!waiting.has(id)) return false;
  taken.add(id);
  return true;
}

/** Whether the request is one this listener answers: its Origin is an allowed one and its Host is this listener's own. */
export function mayAsk(headers, settings) {
  const origin = headers.origin;
  const host = String(headers.host ?? '').toLowerCase();
  const own = [`${settings.host}:${settings.port}`, `localhost:${settings.port}`];
  return typeof origin === 'string' && settings.allowed_origins.includes(origin) && own.includes(host) ? origin : null;
}

/**
 * The listener's answer to one request, as { status, headers, body, open? }: `open` is the path to hand the app. Pure:
 * `request` is { method, url, headers, body (text) }.
 */
export function answerRequest(request, settings) {
  const here = new URL(request.url, 'http://x');
  // The app's own callback: no Origin (it is not a page), but its bundle id in a header a browser cannot add without a
  // preflight, which this listener refuses to every origin it does not allow.
  if (request.method === 'GET' && here.pathname === settings.acknowledged.taken_path) {
    const id = here.searchParams.get('id') ?? '';
    return request.headers[settings.acknowledged.app_header] === settings.bundle_id && acknowledge(id)
      ? { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{}' }
      : { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: settings.words.not_allowed }) };
  }
  const origin = mayAsk(request.headers, settings);
  const say = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}), ...extra }, body: JSON.stringify(body) });
  if (!origin) return say(403, { error: settings.words.not_allowed });
  const path = new URL(request.url, 'http://x').pathname;
  if (request.method === 'OPTIONS') {
    return { status: 204, headers: { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true', 'access-control-max-age': String(settings.preflight_max_age_seconds) }, body: '' };
  }
  if (request.method === 'GET' && path === '/hello') return say(200, { app: 'trillion', bundle_id: settings.bundle_id });
  if (request.method === 'POST' && path === '/open') {
    let asked;
    try { asked = JSON.parse(request.body); } catch { return say(400, { error: settings.words.bad_body }); }
    const opening = openablePath(asked?.path, settings);
    if (!opening) return say(422, { error: settings.words.bad_path });
    return { ...say(200, {}), open: opening };
  }
  return say(404, { error: settings.words.not_found });
}

/** The address `path` as the app takes it, with the one-time id the app calls back with. */
export const addressFor = (path, id, settings) => {
  const [screen, ...fragment] = path.split('#');
  const joined = `${screen}${screen.includes('?') ? '&' : '?'}${settings.acknowledged.id_parameter}=${id}${fragment.length ? `#${fragment.join('#')}` : ''}`;
  return settings.url_template.replace('{path}', joined);
};

/** Hands `path` to the app and says whether the app said it took it: { acknowledged, attempts }. */
export async function openInApp(path, settings, { run = runFile, wait } = {}) {
  const id = crypto.randomUUID();
  waiting.add(id);
  try {
    const [program, ...args] = fill(settings.open_with, { bundle_id: settings.bundle_id, url: addressFor(path, id, settings) });
    return await deliverUntilAcknowledged({ send: () => run(program, args), acknowledged: async () => taken.has(id), ...settings.delivery, ...(wait ? { wait } : {}) });
  } finally { waiting.delete(id); taken.delete(id); }
}

/** Starts the listener; → { stop } (or null when disabled or the port is held). */
export function startOpenFromWeb({ settings = openFromWebSettings(), run = runFile, log = () => {} } = {}) {
  if (!settings.enabled) return Promise.resolve(null);
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size <= settings.most_body_bytes) chunks.push(chunk); });
      req.on('end', async () => {
        const answer = size > settings.most_body_bytes
          ? { status: 413, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: settings.words.bad_body }) }
          : answerRequest({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }, settings);
        if (answer.open) {
          const result = await openInApp(answer.open, settings, { run }).catch(error => ({ acknowledged: false, attempts: 0, errors: [String(error.message ?? error)] }));
          log({ open_from_web: answer.open, acknowledged: result.acknowledged, attempts: result.attempts });
          answer.body = JSON.stringify(result.acknowledged ? { opened: true, attempts: result.attempts } : { opened: false, error: settings.words.not_taken });
          answer.status = result.acknowledged ? 200 : 502;
        }
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body);
      });
    });
    server.on('error', error => { log({ open_from_web_not_listening: String(error.code ?? error.message) }); resolve(null); });
    server.unref();
    server.listen(settings.port, settings.host, () => resolve({ stop: () => new Promise(done => server.close(done)), port: server.address().port }));
  });
}

let started = null;
/** The Mac helper starts this once (computer/mac-tools.json on_start). */
export const openFromWebTools = { start: () => (started ??= startOpenFromWeb({ log: line => process.stderr.write(`${JSON.stringify(line)}\n`) })) };
