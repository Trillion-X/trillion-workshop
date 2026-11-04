// The account key stays in Keychain and this process's memory, never in MCP config.
// Requests go to the account's door on this computer (local-door.mjs), read again for every request, so an AI app's
// config holds no address and a door started again on another port is followed. An MCP address given as the first
// argument is used instead (only https, or http to this computer's own loopback address, so the key is never sent in
// the clear over a network). A request the door does not answer is answered with the cause, never silently dropped.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { accountKeyOrNull } from './account-key.mjs';
import { localDoorAddress } from './local-door.mjs';

const given = process.argv[2] ? new URL(process.argv[2]) : null;
if (given && (!(given.protocol === 'https:' || (given.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(given.hostname))) || given.username || given.password)) {
  throw new Error('Name the MCP address: https, or http to this computer\'s loopback address.');
}
function replies(raw) {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) return [JSON.parse(text)].flat();
  return text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

const safeAddress = address => {
  const parsed = new URL(address);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password) {
    throw new Error('The account door address must use HTTPS or this computer\'s loopback address.');
  }
  return parsed.href;
};

export async function runBridge({ key, address = localDoorAddress, fetchImpl = fetch, input = process.stdin, output = process.stdout } = {}) {
  if (!key?.startsWith('nm_')) throw new Error('Trillion account key unavailable.');
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      const target = safeAddress(typeof address === 'function' ? address() : address);
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`${target} answered HTTP ${response.status}`);
      for (const reply of replies(await response.text())) output.write(`${JSON.stringify(reply)}\n`);
    } catch (error) {
      if (message?.id !== undefined) output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `The account's door did not answer: ${error.cause?.code || error.message}` } })}\n`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const given = process.argv[2] ? new URL(process.argv[2]) : null;
  if (given) safeAddress(given.href);
  const key = accountKeyOrNull({ timeout: 0 }) ?? '';
  runBridge({ key, address: given?.href ?? localDoorAddress }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
