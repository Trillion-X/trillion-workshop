// tools/check-a-site-build-in-a-browser/do-work/serve-build.mjs
//
// Purpose
//   Serves a built site folder on 127.0.0.1 the way a site's front door does: a path is its file, its folder's index.html,
//   or its .html file. Data calls (paths under the settings' data_call_prefix) are passed to the live site, so a page draws
//   from real data without a held value on this computer. Anything else the build has no file for is also passed to the live
//   site (media and assets a build leaves out). With no live origin (a stand-in "live" site) a missing file is a 404.
//
// Non-negotiable invariants
//   1. A data call is passed as asked, GET or POST, with no query parameter added: some live data calls answer 404 to any
//      query string.
//   2. Referer and Origin name the live host (same path for Referer): the live site reads which page asks from them.
//   3. A page view passed to the live site carries the settings' check_query; a data call never does.
//   4. A path never leaves the folder: ".." is cut out, and a resolved file outside the folder is a miss.
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

/** The file a request path names inside `root`: the file itself, its folder's index.html, or the path with .html; null when none. */
export function fileFor(root, requestPath) {
  const base = resolve(root);
  let clean;
  try { clean = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, ''); } catch { return null; }
  for (const candidate of [join(base, clean), join(base, clean, 'index.html'), join(base, `${clean}.html`)]) {
    const inside = resolve(candidate);
    if ((inside === base || inside.startsWith(base + sep)) && existsSync(inside) && statSync(inside).isFile()) return inside;
  }
  return null;
}

function passToLive(live, settings, req, res) {
  const url = new URL(req.url, live);
  if (!url.pathname.startsWith(settings.data_call_prefix)) url.searchParams.set(settings.check_query.name, settings.check_query.value);
  const headers = { ...req.headers, host: url.host };
  for (const key of ['referer', 'origin']) {
    if (!headers[key]) continue;
    try {
      const was = new URL(headers[key]);
      headers[key] = key === 'origin' ? url.origin : `${url.origin}${was.pathname}${was.search}`;
    } catch { delete headers[key]; }
  }
  const out = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers }, reply => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  out.on('error', error => { res.writeHead(502); res.end(String(error.message)); });
  req.pipe(out);
}

/** Starts serving `root` on a free loopback port. `live` is the live origin to pass to, or null. Answers { origin, close() }. */
export async function serveBuild({ root, live = null, settings }) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (live && path.startsWith(settings.data_call_prefix)) { passToLive(live, settings, req, res); return; }
    const file = fileFor(root, path);
    if (file) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } else if (live) passToLive(live, settings, req, res);
    else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}
