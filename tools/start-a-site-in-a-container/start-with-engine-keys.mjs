// tools/start-a-site-in-a-container/start-with-engine-keys.mjs: the one starter a site's container runs (Nov 24 2026). A site's
// image fetches this file at a Workshop commit and refuses it unless its BLAKE3 is the pin its Dockerfile names; the site
// keeps only its DATA, the keys file named as this program's one argument. It starts a site's program the way a computer's
// unit does: on a computer, systemd hands a site its credentials folder ($CREDENTIALS_DIRECTORY) and the site answers on a
// unix socket (SOCKET). In a container no key is in the image, the compose file or the host's settings: at start this asks
// the engine running on the same computer for each value, on the engine's vault socket (POST /vault/read; the engine answers
// a peer only by its own uid's row of vault_readers: that person, those names), so the container runs as its site's own uid
// with the socket's folder mounted read-only, writes each value into an in-memory folder only that user reads, starts the
// site with that folder and one socket, and joins PORT (what the host's proxy reaches) to that socket byte for byte.
//
// The keys file: { "program": the site's program, relative to the site folder; "keys": { credential file name: vault name },
// "environment": { other settings the unit gave it }, "redirect_hosts"?: { host: origin }, "routes"?: { path: origin } }. With
// either of the last two, the port is joined request by request instead of byte for byte. A request for one of
// redirect_hosts is answered 308 to its origin with the same path (a bare name moving to its www name). A request whose path
// is one of routes, or under it (path + "/"), goes to that origin unchanged and streamed: method, path and query, every
// header, the body byte for byte, and the answer's status, headers and body (a signed webhook is checked against the raw
// bytes). A host proxy's path rule may not do this: one wrote a second server block for the same name, which nginx never
// serves (Nov 25 2026). Every other request goes to the site's socket unchanged.
// Environment (from the compose file, none of them a key): ENGINE_SOCKET (the vault socket's path in the container),
// ENGINE_PERSON (the person whose vault holds the values), CREDENTIALS_FOLDER (an in-memory folder), PORT, and optionally
// SITE_FOLDER (the site's repository, the working folder by default) and SITE_SOCKET (/tmp/site.sock by default).
// A value never reaches a line this writes: a refusal names the vault name and the engine's word only.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { request, createServer as createHttpServer } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repository = process.env.SITE_FOLDER ?? process.cwd();
const keysFile = process.argv[2];
if (!keysFile) { console.error('name the site\'s keys file, relative to the site folder: start-with-engine-keys.mjs <keys file>'); process.exit(1); }
const { program, keys = {}, environment = {}, redirect_hosts: redirectHosts, routes = {} } = JSON.parse(readFileSync(join(repository, keysFile), 'utf8'));
const engineSocket = process.env.ENGINE_SOCKET;
const person = process.env.ENGINE_PERSON;
const folder = process.env.CREDENTIALS_FOLDER ?? '/run/site-credentials';
const port = Number(process.env.PORT ?? 3000);
const siteSocket = process.env.SITE_SOCKET ?? '/tmp/site.sock';

const stop = (words) => { console.error(words); process.exit(1); };

// One value from the engine, as bytes; a refusal is the engine's status and word.
const read = (name) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ person, name });
  const ask = request({ socketPath: engineSocket, path: '/vault/read', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (answer) => {
    const parts = [];
    answer.on('data', part => parts.push(part));
    answer.on('end', () => {
      const bytes = Buffer.concat(parts);
      if (answer.statusCode === 200) return resolve(bytes);
      let word = 'no word';
      try { word = String(JSON.parse(bytes).error ?? word).replace(/[^a-z_]/g, ''); } catch {}
      reject(new Error(`the engine refused ${name} (${answer.statusCode}): ${word}`));
    });
  });
  ask.on('error', () => reject(new Error(`the engine does not answer on ${engineSocket}`)));
  ask.end(body);
});

if (Object.keys(keys).length) {
  if (!person) stop('ENGINE_PERSON is needed: the person whose vault holds this site\'s values');
  if (!engineSocket) stop('ENGINE_SOCKET is needed: the engine\'s vault socket in this container');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const [file, name] of Object.entries(keys)) {
    try { writeFileSync(join(folder, file), await read(name), { mode: 0o400 }); }
    catch (error) { stop(error.message); }
  }
  console.log(`held ${Object.keys(keys).length} values from the engine`);
}

const site = spawn(process.execPath, [join(repository, program)], {
  cwd: repository,
  env: { ...process.env, ...environment, SOCKET: siteSocket, ...(Object.keys(keys).length ? { CREDENTIALS_DIRECTORY: folder } : {}) },
  stdio: 'inherit',
});
site.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => site.kill(signal));

const joinBytes = () => createServer((visitor) => {
  const upstream = createConnection(siteSocket);
  visitor.pipe(upstream).pipe(visitor);
  visitor.on('error', () => upstream.destroy());
  upstream.on('error', () => visitor.destroy());
});
// The origin a request's path is routed to, or undefined: a route is its path exactly or anything under it.
const routed = (url) => {
  const path = String(url).split('?')[0];
  const prefix = Object.keys(routes).find(route => path === route || path.startsWith(`${route.replace(/\/$/, '')}/`));
  return prefix && new URL(routes[prefix]);
};
const joinRequests = () => createHttpServer((asked, answer) => {
  const origin = (redirectHosts ?? {})[String(asked.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')];
  if (origin) {
    answer.writeHead(308, { location: origin + asked.url, 'cache-control': 'no-store' });
    answer.end();
    return;
  }
  const to = routed(asked.url);
  const where = to ? { host: to.hostname, port: to.port || 80 } : { socketPath: siteSocket };
  const upstream = request({ ...where, path: asked.url, method: asked.method, headers: asked.headers }, (site) => {
    answer.writeHead(site.statusCode, site.rawHeaders);
    site.pipe(answer);
  });
  upstream.on('error', () => { if (!answer.headersSent) answer.writeHead(502); answer.end(); });
  asked.pipe(upstream);
});
const byRequest = Boolean(redirectHosts) || Object.keys(routes).length > 0;
const joinPort = () => (byRequest ? joinRequests() : joinBytes())
  .listen(port, () => console.log(`joining port ${port} to ${siteSocket}${byRequest ? ` (request by request${Object.keys(routes).length ? `; ${Object.keys(routes).join(', ')} routed` : ''})` : ''}`));
const wait = setInterval(() => { if (existsSync(siteSocket)) { clearInterval(wait); joinPort(); } }, 100);
