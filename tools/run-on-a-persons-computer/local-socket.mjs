// computer/local-socket.mjs
//
// Purpose: lets an AI program on this Mac run the tools this Mac host keeps without a trip through the account: one Unix
// socket, one JSON line in and one signed JSON line out. Opt-in (computer/local-socket.json `enabled`).
//
// Non-negotiable invariants
//   1. The socket is in a folder of mode 0700 and has mode 0600: the operating system lets only the person's own programs
//      connect. This file does not verify which program connected (Node cannot read the peer's identity); it does not
//      claim to.
//   2. A tool runs only through the host's own runner (the one the account's runs use), so every check that runner makes
//      (file scope, consent, off-limits classes) applies on this road too. `allowed_tools` narrows it further.
//   3. Every answer carries `signature`: keyed BLAKE3 of the canonical answer under the secret in `secret_file`
//      (created 0600 on first start, never printed or logged), so a caller holding the file can verify the answer.
//   4. A line longer than most_line_bytes closes the connection; a malformed line is answered, never ignored.
import { randomBytes } from 'node:crypto';
import { makeHashCodeHexFromBytes, makeKeyedHashHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const localSocketSettings = () => JSON.parse(readFileSync(join(HERE, 'local-socket.json'), 'utf8'));
const expand = (path, home) => path.replace(/^~(?=\/|$)/, home);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const canonical = value => JSON.stringify(value, (_, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner));

/** The signing key, created 0600 on first use. */
export function secretOf(settings, home = homedir()) {
  const file = expand(settings.secret_file, home);
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true, mode: settings.folder_mode }); writeFileSync(file, randomBytes(32).toString('hex'), { mode: settings.socket_mode }); }
  return readFileSync(file, 'utf8').trim();
}
export const sign = (answer, secret) => makeKeyedHashHexFromBytes(Buffer.from(makeHashCodeHexFromBytes(new TextEncoder().encode(secret)).slice(3), 'hex'), new TextEncoder().encode(canonical(answer)));
export const verify = (answer, secret) => { const { signature, ...rest } = answer; return typeof signature === 'string' && signature === sign(rest, secret); };

/** Starts the road. run({ tool_id, input }) is the host's runner. → { path, close() } or null when it is switched off. */
export async function startLocalSocket({ settings = localSocketSettings(), run, home = homedir(), log = () => {} }) {
  if (settings.enabled !== true) return null;
  const path = expand(settings.path, home), secret = secretOf(settings, home);
  mkdirSync(dirname(path), { recursive: true, mode: settings.folder_mode });
  chmodSync(dirname(path), settings.folder_mode);
  if (existsSync(path)) unlinkSync(path);
  const reply = (socket, body) => socket.write(`${JSON.stringify({ ...body, signature: sign(body, secret) })}\n`);
  const server = createServer(socket => {
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      pending += chunk;
      if (Buffer.byteLength(pending) > settings.most_line_bytes) { socket.destroy(); return; }
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        let request;
        try { request = JSON.parse(line); } catch { reply(socket, { id: null, error: settings.words.bad_request }); continue; }
        if (!request || typeof request.tool_id !== 'string') { reply(socket, { id: request?.id ?? null, error: settings.words.bad_request }); continue; }
        if (settings.allowed_tools && !settings.allowed_tools.includes(request.tool_id)) { reply(socket, { id: request.id ?? null, error: fill(settings.words.not_allowed, { tool: request.tool_id }) }); continue; }
        try { reply(socket, { id: request.id ?? null, result: await run({ tool_id: request.tool_id, input: request.input ?? {} }) }); }
        catch (error) { log({ local_socket_failed: String(error.message ?? error) }); reply(socket, { id: request.id ?? null, error: String(error.message ?? error) }); }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, settings.socket_mode);
  return { path, close: () => new Promise(resolve => server.close(() => { try { unlinkSync(path); } catch { /* already gone */ } resolve(); })) };
}

/** One call over the road, verified: { id, result } or { id, error }; rejects when the signature does not verify. */
export function callLocal({ path, secret }, tool_id, input = {}, id = 1) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      socket.end();
      const answer = JSON.parse(text.split('\n')[0]);
      verify(answer, secret) ? resolve(answer) : reject(new Error('The answer was not signed by this Mac host.'));
    });
    socket.write(`${JSON.stringify({ id, tool_id, input })}\n`);
  });
}
