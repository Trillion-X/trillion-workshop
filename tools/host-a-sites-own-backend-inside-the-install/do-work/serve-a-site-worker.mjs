// tools/host-a-sites-own-backend-inside-the-install/do-work/serve-a-site-worker.mjs
//
// Serves a site's own backend on a computer the site's owner chooses: the same Worker bundle a Workers host would run (wrangler's
// own bundle of the site's worker, `wrangler deploy --dry-run --outdir`), with its runtime made here (read-data/workers-stand-ins.mjs).
// It is one program for any such site, run by a unit of the computer's row; the site names only its settings. The computer's web
// server passes every request on; this answers it the way the Workers runtime does for the site's wrangler settings:
//   - a built file in the site folder answers its address first (assets.html_handling auto-trailing-slash: /a is a.html or
//     a/index.html, and /a/index.html moves to /a/), except the addresses `run_worker_first` names, which the Worker answers;
//   - every other request goes to the Worker's fetch(request, env, ctx), with env.ASSETS reading the same folder;
//   - dist/_headers lines are added to the files they name.
// The visitor's address comes from the X-Forwarded-For the computer's own web server sets, as cf-connecting-ip.
//
// Settings (environment): SITE_BUNDLE (the bundle's index.js), SITE_FILES (the built folder), SOCKET or PORT, SITE_SETTINGS (a JSON file:
// { vars, run_worker_first, email_account, kv_table }). Held values come from the unit's credentials folder
// ($CREDENTIALS_DIRECTORY): site-database (the Postgres connection) and email-sending-token (optional); every other file there is
// one of the Worker's secrets, named in the env the way its file is named in capitals (mail-link-key is env.MAIL_LINK_KEY).
// GET /readyz answers 200 once the Worker is loaded and the database answers, 503 while this process drains (SIGTERM).
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { HTMLRewriter, WorkerEntrypoint, cachesDefault, d1, emailSending, kv, workerSecrets } from '../read-data/workers-stand-ins.mjs';

const settings = JSON.parse(readFileSync(process.env.SITE_SETTINGS, 'utf8'));
const files = resolve(process.env.SITE_FILES);
const held = name => {
  const folder = process.env.CREDENTIALS_DIRECTORY;
  const file = folder && join(folder, name);
  return file && existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
};

globalThis.HTMLRewriter = HTMLRewriter;
globalThis.caches = { default: cachesDefault() };

// The bundle imports its base class from `cloudflare:workers`, a module only that runtime has: the one import is pointed here.
const bundle = resolve(process.env.SITE_BUNDLE);
const runnable = bundle.replace(/\.js$/, '.node.mjs');
const source = readFileSync(bundle, 'utf8');
const runtimeImport = 'import { WorkerEntrypoint } from "cloudflare:workers";';
if (!source.includes(runtimeImport)) throw new Error('The bundle does not import WorkerEntrypoint from cloudflare:workers as expected; rebuild it with this server.');
writeFileSync(runnable, source.replace(runtimeImport, `import { WorkerEntrypoint } from ${JSON.stringify(pathToFileURL(new URL('../read-data/workers-stand-ins.mjs', import.meta.url).pathname).href)};`));
void WorkerEntrypoint;
const worker = (await import(pathToFileURL(runnable).href)).default;

const pool = new pg.Pool({ connectionString: held('site-database'), max: 8 });
// D1 had sqlite_master; the Worker asks it whether a table exists. The same question, asked of this database.
await pool.query(`CREATE OR REPLACE VIEW sqlite_master AS SELECT 'table'::text AS type, table_name::text AS name FROM information_schema.tables WHERE table_schema = current_schema()`);

// The `_headers` file: a path line, then indented `Name: value` lines. `*` at the end of a path matches the rest.
const extraHeaders = (() => {
  const file = join(files, '_headers');
  if (!existsSync(file)) return [];
  const rules = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
    else if (rules.length) { const at = line.indexOf(':'); rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]); }
  }
  return rules;
})();
const headersFor = path => extraHeaders.filter(rule => (rule.path.endsWith('*') ? path.startsWith(rule.path.slice(0, -1)) : path === rule.path)).flatMap(rule => rule.headers);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json' };

const fileAt = path => {
  const full = normalize(join(files, decodeURIComponent(path)));
  if (!full.startsWith(files + '/') && full !== files) return null;
  try { return statSync(full).isFile() ? full : null; } catch { return null; }
};
// html_handling auto-trailing-slash: the file an address names, or a redirect to the address that names it.
function asset(url) {
  const path = url.pathname;
  if (path.endsWith('/index.html')) return fileAt(path) ? { redirect: path.slice(0, -'index.html'.length) } : null;
  if (path.endsWith('.html') && fileAt(path)) return { redirect: path.slice(0, -'.html'.length) };
  if (path.endsWith('/')) { const file = fileAt(`${path}index.html`); return file ? { file, path } : null; }
  const exact = fileAt(path);
  if (exact) return { file: exact, path };
  const html = fileAt(`${path}.html`);
  if (html) return { file: html, path };
  if (fileAt(`${path}/index.html`)) return { redirect: `${path}/` };
  return null;
}
function assetResponse(found, url, method) {
  if (found.redirect) return new Response(null, { status: 307, headers: { location: found.redirect + url.search } });
  const headers = new Headers({ 'content-type': types[extname(found.file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'public, max-age=0, must-revalidate' });
  for (const [name, value] of headersFor(found.path)) headers.set(name, value);
  return new Response(method === 'HEAD' ? null : readFileSync(found.file), { status: 200, headers });
}

const env = {
  ...settings.vars,
  ...workerSecrets(process.env.CREDENTIALS_DIRECTORY, { readdirSync, readFileSync }),
  DB: d1(pool),
  SHARED_LISTS: kv(pool, settings.kv_table ?? 'site_shared_lists'),
  EMAIL: emailSending({ account: settings.email_account, token: held('email-sending-token') }),
  ASSETS: { fetch: async request => { const url = new URL(typeof request === 'string' ? request : request.url); const found = asset(url); return found ? assetResponse(found, url, request.method ?? 'GET') : new Response('Not found', { status: 404 }); } },
};
const workerFirst = new Set(settings.run_worker_first ?? []);

let draining = false;
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url, `https://${host}`);
    if (url.pathname === '/readyz') {
      const ok = !draining && (await pool.query('SELECT 1').then(() => true, () => false));
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }); res.end(ok ? 'ready' : 'not ready'); return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() || req.socket.remoteAddress;
    headers.set('cf-connecting-ip', forwarded);
    const method = req.method ?? 'GET';
    const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : req, duplex: 'half' });
    const found = workerFirst.has(url.pathname) ? null : (method === 'GET' || method === 'HEAD') && asset(url);
    const pending = [];
    const answer = found ? assetResponse(found, url, method)
      : await worker.fetch(request, env, { waitUntil: work => pending.push(Promise.resolve(work).catch(error => console.error(JSON.stringify({ wait_until: String(error) })))), passThroughOnException() {} });
    const out = {};
    answer.headers.forEach((value, name) => { if (name !== 'set-cookie') out[name] = value; });
    const cookies = answer.headers.getSetCookie?.() ?? [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(answer.status, out);
    if (answer.body && method !== 'HEAD') { for await (const chunk of answer.body) res.write(chunk); }
    res.end();
  } catch (error) {
    console.error(JSON.stringify({ unhandled: String(error?.stack ?? error).slice(0, 4000) }));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Something broke on our side. Try again in a moment.');
  }
});
// SOCKET (a comma-separated list of unix socket paths, as a computer's web server sends a site's program its requests) or PORT
// on loopback. Every address answers the same requests.
const servers = process.env.SOCKET
  ? process.env.SOCKET.split(',').map(path => path.trim()).filter(Boolean).map((path, index) => (index ? createServer(server.listeners('request')[0]) : server).listen(path, () => console.log(JSON.stringify({ serving: path }))))
  : [server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => console.log(JSON.stringify({ serving: Number(process.env.PORT ?? 8787) })))];
process.on('SIGTERM', () => {
  draining = true;
  setTimeout(() => Promise.all(servers.map(one => new Promise(done => one.close(done)))).then(() => pool.end()).then(() => process.exit(0)), Number(process.env.STOP_HOLD_MS ?? 3000));
});
