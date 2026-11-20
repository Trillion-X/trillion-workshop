// The pass in front of the gateway's HTTP port. A request must carry `Authorization: Bearer <pass>`. The pass is held in
// the vault under the name the gateway's config row gives (`pass_vault`); the run mounts that vault value on
// descriptor 4 as a pipe, the same way the Composio connection reads its key (tools/composio-connection/read-data/composio-call.mjs).
// It is never in a file, an argument or a log. With no pass the gateway does not start: serve.mjs exits with a refusal.
// A request without the right pass is answered 401 before any app process is started. The one-off flow is in-process
// (gateway.mjs createGateway, no port), so the pass guards the port only.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, fstatSync } from 'node:fs';

const HELD_DESCRIPTOR = 4;
const READ_LIMIT_MS = 2000;
const digest = value => createHash('sha256').update(String(value)).digest();

/** The pass the engine mounted on descriptor 4, trimmed, read within `timeoutMs`. Only a pipe counts: a file on that number
 *  is refused. A closed descriptor is no pass, and Node's own pipe there (when it was closed at start) never ends, so the
 *  read gives up at the bound. Resolves to '' when no pass was given. */
export function heldPass({ timeoutMs = READ_LIMIT_MS, stat = fstatSync, open = () => createReadStream(null, { fd: HELD_DESCRIPTOR, autoClose: false }) } = {}) {
  return new Promise(resolve => {
    try {
      if (!stat(HELD_DESCRIPTOR).isFIFO()) return resolve('');
    } catch {
      return resolve('');
    }
    const stream = open();
    const chunks = [];
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8').trim()));
    stream.on('error', () => finish(''));
  });
}

/** The check for one pass: `allows(request)` is true only for the right bearer pass. Throws when there is no pass. */
export function gatewayPass(token) {
  if (typeof token !== 'string' || token.trim() === '') throw new Error('no pass was given on descriptor 4, so the gateway does not start');
  const expected = digest(token.trim());
  return {
    allows(request) {
      const given = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
      return timingSafeEqual(digest(given), expected);
    },
  };
}

/** The HTTP handler: a request without the pass is answered 401 and never reaches the gateway. */
export function guarded(gateway, pass) {
  return (request, response) => {
    if (pass.allows(request)) return void gateway.handle(request, response);
    const text = JSON.stringify({ error: 'A pass is needed: send Authorization: Bearer <pass>.' });
    response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer', 'content-length': Buffer.byteLength(text) });
    response.end(text);
  };
}
