// tools/check-a-site-build-in-a-browser/do-work/serve-candidate.mjs
//
// Purpose
//   A loopback front door for a candidate: a new unit of a site that has no built folder (it draws its pages from rows), placed
//   beside the live one at a side address. The browser opens 127.0.0.1; every request is passed to the candidate as if it were
//   asked of the live host, so a unit that picks its site by host answers the same site it will answer once live.
//
// Non-negotiable invariants
//   1. The candidate is an http(s) origin or a unix socket ("unix:/path/to.sock"); every request goes to it, data calls too: the
//      candidate's own server is what is checked.
//   2. Host is the live host; Referer and Origin name the live origin (same path for Referer); X-Forwarded-Host and
//      X-Forwarded-Proto say the live host and scheme. Nothing is added to a request's query.
//   3. A redirect to the live origin or the candidate's own origin comes back as one to this door, so the browser stays on the
//      candidate; a redirect anywhere else is passed as it is.
//   4. A candidate that cannot be reached answers 502 with the header in settings.candidate_error_header, so it is never
//      mistaken for a page the candidate drew.
import http from 'node:http';
import https from 'node:https';

/** Starts the door on a free loopback port for the candidate as the live origin `live`. Answers { origin, close() }. */
export async function serveCandidate({ candidate, live, settings }) {
  const liveUrl = new URL(live);
  const socketPath = candidate.startsWith('unix:') ? candidate.slice('unix:'.length) : null;
  const target = socketPath ? null : new URL(candidate);
  let self = null;
  const toSelf = location => {
    let where;
    try { where = new URL(location, liveUrl); } catch { return location; }
    return where.origin === liveUrl.origin || (target && where.origin === target.origin) ? `${self}${where.pathname}${where.search}${where.hash}` : location;
  };
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: liveUrl.host, 'x-forwarded-host': liveUrl.host, 'x-forwarded-proto': liveUrl.protocol.slice(0, -1) };
    for (const key of ['referer', 'origin']) {
      if (!headers[key]) continue;
      try {
        const was = new URL(headers[key]);
        headers[key] = key === 'origin' ? liveUrl.origin : `${liveUrl.origin}${was.pathname}${was.search}`;
      } catch { delete headers[key]; }
    }
    const options = socketPath ? { socketPath, path: req.url, method: req.method, headers }
      : { protocol: target.protocol, hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers, servername: target.hostname };
    const out = (target?.protocol === 'https:' ? https : http).request(options, reply => {
      const replyHeaders = { ...reply.headers };
      if (replyHeaders.location) replyHeaders.location = toSelf(replyHeaders.location);
      res.writeHead(reply.statusCode ?? 502, replyHeaders);
      reply.pipe(res);
    });
    out.on('error', error => {
      if (res.headersSent) { res.destroy(error); return; }
      res.writeHead(502, { 'content-type': 'text/plain', [settings.candidate_error_header]: '1' });
      res.end(String(error.message));
    });
    req.pipe(out);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  self = `http://127.0.0.1:${server.address().port}`;
  return { origin: self, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}
