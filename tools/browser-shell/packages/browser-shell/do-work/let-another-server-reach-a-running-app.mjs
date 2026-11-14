// packages/browser-shell/do-work/let-another-server-reach-a-running-app.mjs
//
// PURPOSE
//   Lets any existing web server host Bitfield packages without becoming a
//   Bitfield app. A page that loads the runtime's shell-runtime.js and calls
//   installBitfieldBootHooks() talks to a runtime over four same-origin paths:
//   /boot, /target/<name>, /cas/<hash> and the /ws socket. This module answers
//   exactly those four on the host's own origin by forwarding them to a Bitfield
//   app already running on this computer, so the host keeps one origin and every
//   other path stays the host's own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The socket is never configured by hand. It is read from the running app's
//      own published ready file on every connection, so a relaunch (new socket)
//      is picked up with no restart of the host.
//   2. Which app to reach is the caller's DATA (an app id). Nothing here knows
//      any app, host or package by name.
//   3. Only the four runtime paths are claimed. Anything else returns false and
//      stays with the host.
//   4. An app that is not running is reported as that, in words, with a 503. It
//      is never retried here and never answered with invented data. For /boot
//      the 503 also carries the runtime's own `recovering` shape, so the page
//      keeps waiting and connects when the app opens instead of failing every
//      package screen at once (a closed app is the same to the page as one
//      still starting).

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_PATHS = [
  {kind: 'exact', path: '/boot'},
  {kind: 'prefix', path: '/target/'},
  {kind: 'prefix', path: '/cas/'},
  {kind: 'exact', path: '/ws'},
];

export function isRuntimePath(pathname) {
  return RUNTIME_PATHS.some(rule => rule.kind === 'exact' ? pathname === rule.path : pathname.startsWith(rule.path));
}

export function readyFileFor(appId, home = os.homedir()) {
  if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Choose a Bitfield app id to reach.');
  return path.join(home, '.bitfield', 'runtime-kit', 'app-log-storage-folders',
    `app-log-storage-for-bitfield-app-${Buffer.from(appId, 'utf8').toString('hex')}`,
    'runtime-kit', 'running-now', 'open-this-bitfield-app', 'this-bitfield-shell-is-ready.json');
}

export function currentSocketFor(appId, home) {
  const file = readyFileFor(appId, home);
  let ready;
  try { ready = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${appId} is not open on this computer.`); }
  const socketPath = ready?.status === 'ready' ? ready.attachments?.forwarding_socket : null;
  if (typeof socketPath !== 'string' || !socketPath) throw new Error(`${appId} is still starting.`);
  try { if (!fs.statSync(socketPath).isSocket()) throw new Error(); } catch { throw new Error(`${appId} is not open on this computer.`); }
  return socketPath;
}

// One request to one target of the running app, from the host's own server.
// The running command-list basis is read from the same ready file as the
// socket, so a request always names the target list the app is serving now.
export async function sendToRunningApp({appId, home, target, payload}) {
  const socketPath = currentSocketFor(appId, home);
  const ready = JSON.parse(fs.readFileSync(readyFileFor(appId, home), 'utf8'));
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request({socketPath, path: `/target/${encodeURIComponent(target)}`, method: 'POST', headers: {
      host: 'localhost', 'content-type': 'application/octet-stream', 'content-length': body.length,
      'X-Bitfield-Running-Command-List-Basis': ready.running_command_list_basis,
    }}, reply => {
      const chunks = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value; try { value = JSON.parse(text); } catch { value = text; }
        if ((reply.statusCode || 500) >= 400) reject(new Error(value?.message || `${target} answered ${reply.statusCode}`));
        else resolve(value);
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** How long a page waits before asking /boot again while the app is not open. */
export const BOOT_RETRY_AFTER_MILLISECONDS = 2000;

export function createRunningAppReach({appId, home}) {
  function unavailable(res, error, pathname) {
    if (res.headersSent) { res.destroy(error); return; }
    res.writeHead(503, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({code: 'APP_NOT_OPEN', message: error.message,
      ...(pathname === '/boot' ? {status: 'recovering', retry_after_milliseconds: BOOT_RETRY_AFTER_MILLISECONDS} : {})}));
  }

  // Plain requests: the socket speaks HTTP, so the request is replayed on it
  // unchanged and the reply streamed back unchanged.
  function handleRequest(req, res, pathname) {
    if (!isRuntimePath(pathname) || pathname === '/ws') return false;
    let socketPath;
    try { socketPath = currentSocketFor(appId, home); } catch (error) { unavailable(res, error, pathname); return true; }
    const upstream = http.request({socketPath, path: req.url, method: req.method, headers: {...req.headers, host: 'localhost'}}, reply => {
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', error => unavailable(res, error, pathname));
    req.pipe(upstream);
    return true;
  }

  // The live socket: the upgrade request is written through verbatim, then the
  // two connections are joined byte for byte for as long as either stays open.
  function handleUpgrade(req, clientSocket, head, pathname) {
    if (pathname !== '/ws') return false;
    let socketPath;
    try { socketPath = currentSocketFor(appId, home); } catch { clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return true; }
    const upstream = net.createConnection(socketPath, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? 'localhost' : req.rawHeaders[index + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const closeBoth = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', closeBoth);
    clientSocket.on('error', closeBoth);
    return true;
  }

  return {handleRequest, handleUpgrade};
}
