// extension/native-host/browser-native-host.mjs
//
// PURPOSE
//   The program a browser starts when Trillion's own extension asks this computer something directly
//   (chrome.runtime.sendNativeMessage), through the native messaging host manifest extension/native-host/offer-in-browsers.mjs
//   places. It speaks the browser's native messaging framing on standard input and output: each message is a 32-bit
//   length in this computer's byte order followed by that many bytes of JSON. A message is { action }; the answer is
//   { ok: true, ...answer } or { ok: false, error }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only an extension the manifest pins may start it: the browser checks `allowed_origins`, and this program checks
//      the origin the browser names as its first argument against the same DATA (offer-in-browsers.json) again, and
//      answers nothing to any other caller.
//   2. Which actions a host answers is DATA (`native_hosts[].actions`); an action not listed for this host is refused.
//      No action runs anything the call names. An action that needs the person's Trillion is a `door_actions` row: it
//      asks the engine's door on this computer (engine-door.mjs) for the resource address and method its row names, with
//      the key from the Mac app's key store; the key never reaches an answer, and the message gives only its `input`.
//   3. Bounded: a message over `most_message_bytes` ends the program (while the browser holds the relay open, an answer to a
//      relayed request may be as large as that relay's `most_answer_bytes`); an answer never exceeds the browser's 1 MB.
//   4. The relay (the relay in tools/run-tools-in-my-signed-in-browser) is opened only by the `relay_open` action of a host that lists it, and closed when the
//      browser closes the pipe, so no door outlives the connection that feeds it.
//
import { readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doorAnswers, reportedPort, vaultPublicKey } from './engine-door.mjs';
import { makeRelay } from '../../run-tools-in-my-signed-in-browser/browser-relay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSWER_LIMIT = 1024 * 1024;

/** What each action answers. Which of them a host answers is DATA. */
export const answers = {
  here: async () => ({ computer: hostname(), program: 'trillion' }),
};

/** One framed message: the 4-byte length in this computer's byte order, then the JSON. */
export const frame = value => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
};

/** Whether `origin` is one of the extensions the host row named `name` pins. */
export function originAllowed({ settings, name, origin }) {
  const host = settings.native_hosts.find(row => row.name === name);
  return Boolean(host) && settings.offers.filter(offer => host.offers.includes(offer.id)).map(offer => `chrome-extension://${offer.extension_id}/`).includes(origin);
}

/** The answer to one message from `origin`, by the host row named `name` in the settings. */
export async function answerMessage({ settings, name, origin, message, actions = answers }) {
  const host = settings.native_hosts.find(row => row.name === name);
  if (!originAllowed({ settings, name, origin })) return { ok: false, error: 'This program answers only the extensions its settings name.' };
  const action = message?.action;
  if (typeof action !== 'string' || !host.actions.includes(action) || !Object.hasOwn(actions, action)) return { ok: false, error: `This computer does not answer ${String(action)}.` };
  try {
    const answer = { ok: true, action, ...await actions[action](message) };
    return Buffer.byteLength(JSON.stringify(answer)) > ANSWER_LIMIT ? { ok: false, error: 'The answer is too large for the browser.' } : answer;
  } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 300) }; }
}

/**
 * Reads framed messages from `input` and writes framed answers to `output` until the browser closes the pipe. `relay` is the
 * one door this connection may open; a { relay_answer } message is the browser's answer to a request the relay passed on, and
 * is answered with nothing.
 */
export async function serve({ settings, name, origin, input, output, actions = answers, relay = null }) {
  let held = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      held = Buffer.concat([held, chunk]);
      while (held.length >= 4) {
        const size = held.readUInt32LE(0);
        if (size > (relay?.open_now ? Math.max(settings.most_message_bytes, relay.most_answer_bytes) : settings.most_message_bytes)) return;
        if (held.length < 4 + size) break;
        let message = null;
        try { message = JSON.parse(held.subarray(4, 4 + size).toString('utf8')); } catch { /* answered as an unknown action */ }
        held = held.subarray(4 + size);
        if (relay && message?.relay_answer !== undefined) { if (originAllowed({ settings, name, origin })) relay.answer(message); continue; }
        if (size > settings.most_message_bytes) return;
        output.write(frame(await answerMessage({ settings, name, origin, message, actions })));
      }
    }
  } finally { relay?.close(); }
}

// Started by the browser through the launcher offer-in-browsers.mjs writes: argv is [host name, caller origin, ...].
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const settings = JSON.parse(readFileSync(join(HERE, 'offer-in-browsers.json'), 'utf8'));
  const host = settings.native_hosts.find(row => row.name === process.argv[2]);
  const config = JSON.parse(readFileSync(join(HERE, '../../run-tools-in-my-signed-in-browser/browser-relay.json'), 'utf8'));
  // The port is the one this computer's own report names; the key's public half is the vault's, asked at each opening.
  const relay = makeRelay({ config, send: message => process.stdout.write(frame(message)),
    readPort: () => reportedPort(settings.engine_door, config.port_name), readPublicKey: () => vaultPublicKey(settings.engine_door, config.key_name) });
  await serve({ settings, name: process.argv[2], origin: process.argv[3], input: process.stdin, output: process.stdout,
    actions: { ...answers, ...doorAnswers(settings, host), relay_open: () => relay.open() }, relay });
}
