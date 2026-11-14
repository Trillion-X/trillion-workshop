// The Better Auth node server, mounted as its Node integration docs show (toNodeHandler from better-auth/node). Requests under
// the base path, and the OAuth and protected-resource discovery documents under /.well-known/, go to Better Auth.

import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { auth, settings } from './auth.mjs';

const handler = toNodeHandler(auth);
const ours = url => url.startsWith(`${settings.base_path}/`) || url.startsWith('/.well-known/');

createServer((request, response) => {
  if (ours(request.url ?? '')) return handler(request, response);
  response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
}).listen(settings.port, '127.0.0.1', () => {
  console.log(`better-auth listening on ${settings.base_url}${settings.base_path}`);
});
