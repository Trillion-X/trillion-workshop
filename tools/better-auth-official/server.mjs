// The Better Auth node server, mounted as its Node integration docs show (toNodeHandler from better-auth/node). Requests under
// the base path, and the OAuth and protected-resource discovery documents under /.well-known/, go to Better Auth. The
// sign-in pages are this tool's own files (pages/), answered by address as pages/routes.json says (pages.mjs).

import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { auth, pool, settings } from './auth.mjs';
import { migrateStore, refuseWhileLegacyWaits } from './store.mjs';
import { pageAnswer } from './pages.mjs';
import { relatedOrigins } from './attached-origins.mjs';
import { serveInternal } from './internal-verify.mjs';

// Every start makes or updates the tables for the options it runs, one process at a time (store.mjs), before it answers anything.
await migrateStore(auth, pool);
await refuseWhileLegacyWaits(settings, pool);

const handler = toNodeHandler(auth);
const ours = url => url.startsWith(`${settings.base_path}/`) || url.startsWith('/.well-known/');

createServer(async (request, response) => {
  const url = request.url ?? '';
  if (url === '/.well-known/webauthn' && request.method === 'GET') {
    return relatedOrigins(settings).then(body => response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' }).end(JSON.stringify(body)));
  }
  if (ours(url)) return handler(request, response);
  const answer = request.method === 'GET' || request.method === 'HEAD' ? pageAnswer(url) : null;
  if (answer) return response.writeHead(answer.status, answer.headers).end(request.method === 'HEAD' ? undefined : answer.body);
  response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
}).listen(settings.port, '127.0.0.1', () => {
  console.log(`better-auth listening on ${settings.base_url}${settings.base_path}`);
});

// The computer's own side: the engine's API key check (internal-verify.mjs), on a listener Caddy never reaches.
if (settings.internal) {
  serveInternal(auth, settings.internal, settings.credential_standing).on('listening', () => console.log(`better-auth internal on ${settings.internal.host}:${settings.internal.port}`));
}
