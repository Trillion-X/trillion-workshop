// tools/use-trillion-from-a-shell/do-work/local-door.mjs
//
// Moved from Trillion-X/trillion harness/local-door.mjs.
//
// The account's MCP door on this computer: the loopback address the Mac app's engine (`trillion-local serve CONFIG`)
// serves its one account at, `http://127.0.0.1:<port>/a/<address>/mcp`. It is read at every call from the app that runs
// this program, so no address or port is copied into an AI app's config, a setting or source, and an engine started
// again on another port is followed. The app's sealed declaration (Contents/Resources/computer-reader.json
// `local_runtime.computer`) names the computer's folder under Application Support (`folder`), the loopback host
// (`listen_host`) and the port (`port`); the account's address is the one `account create` printed, kept in that folder's
// account.json. Who calls the door is the engine's own check of a pass the sign-in tool signed: this file only finds it.
// The engine admits only the host of its `public_origin` (`local_runtime.computer.public_origin`), so a call to the loopback
// door sends that host as Host (`localDoorHost`, `hostFetch`): a local AI goes straight in, with no round trip over the internet.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const readText = file => readFileSync(file, 'utf8');

/** The app bundle's Contents folder holding `runtime` (its own node, Contents/MacOS/node). */
const contentsOf = runtime => dirname(dirname(runtime));

/** The door's MCP address, http://127.0.0.1:<port>/a/<address>/mcp. */
export function localDoorAddress({ runtime = process.execPath, home = os.homedir(), read = readText } = {}) {
  let computer;
  try { computer = JSON.parse(read(join(contentsOf(runtime), 'Resources', 'computer-reader.json'))).local_runtime?.computer; }
  catch { computer = undefined; }
  const folder = computer?.folder;
  if (typeof folder !== 'string' || !folder || isAbsolute(folder) || folder.split('/').includes('..')) {
    throw new Error('Run this with the node inside the installed Mac app, which names its local door.');
  }
  const { port, listen_host: host } = computer;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || host !== '127.0.0.1') throw new Error('The Mac app names no loopback door on this computer.');
  let address;
  try { ({ address } = JSON.parse(read(join(home, 'Library', 'Application Support', folder, 'account.json')))); }
  catch { address = undefined; }
  if (typeof address !== 'string' || !/^[a-f0-9]{64}$/.test(address)) throw new Error('The Mac app has no account on this computer yet.');
  return `http://${host}:${port}/a/${address}/mcp`;
}

/** The Host the engine admits, read from the app's sealed declaration (`local_runtime.computer.public_origin`), or null. */
export function localDoorHost({ runtime = process.execPath, read = readText } = {}) {
  try { return new URL(JSON.parse(read(join(contentsOf(runtime), 'Resources', 'computer-reader.json'))).local_runtime.computer.public_origin).host; }
  catch { return null; }
}

/** A `fetch` for one loopback door that sends `host` as Host (Node's fetch will not): the call over node:http, answered as a Response. */
export const hostFetch = host => (url, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const call = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: { ...headers, host }, signal }, answer => {
    const chunks = [];
    answer.on('data', chunk => chunks.push(chunk));
    answer.on('end', () => resolve(new Response([204, 304].includes(answer.statusCode) ? null : Buffer.concat(chunks), { status: answer.statusCode, headers: answer.headers })));
    answer.on('error', reject);
  });
  call.on('error', reject);
  call.end(body);
});
