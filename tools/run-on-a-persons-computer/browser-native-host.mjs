// computer/browser-native-host.mjs
//
// PURPOSE
//   The program a browser starts when Trillion's own extension asks this computer something directly
//   (chrome.runtime.sendNativeMessage), through the native messaging host manifest computer/offer-in-browsers.mjs
//   places. It speaks the browser's native messaging framing on standard input and output: each message is a 32-bit
//   length in this computer's byte order followed by that many bytes of JSON. A message is { action }; the answer is
//   { ok: true, ...answer } or { ok: false, error }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only an extension the manifest pins may start it: the browser checks `allowed_origins`, and this program checks
//      the origin the browser names as its first argument against the same DATA (offer-in-browsers.json) again, and
//      answers nothing to any other caller.
//   2. Which actions a host answers is DATA (`native_hosts[].actions`); an action not listed for this host is refused.
//      No action takes the account key, writes the person's files or runs anything the call names.
//   3. Bounded: a message over `most_message_bytes` ends the program; an answer never exceeds the browser's 1 MB.
//
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The answer to one message from `origin`, by the host row named `name` in the settings. */
export async function answerMessage({ settings, name, origin, message, actions = answers }) {
  const host = settings.native_hosts.find(row => row.name === name);
  const allowed = host ? settings.offers.filter(offer => host.offers.includes(offer.id)).map(offer => `chrome-extension://${offer.extension_id}/`) : [];
  if (!allowed.includes(origin)) return { ok: false, error: 'This program answers only Trillion\'s own extension.' };
  const action = message?.action;
  if (typeof action !== 'string' || !host.actions.includes(action) || !Object.hasOwn(actions, action)) return { ok: false, error: `This computer does not answer ${String(action)}.` };
  try {
    const answer = { ok: true, action, ...await actions[action]() };
    return Buffer.byteLength(JSON.stringify(answer)) > ANSWER_LIMIT ? { ok: false, error: 'The answer is too large for the browser.' } : answer;
  } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 300) }; }
}

/** Reads framed messages from `input` and writes framed answers to `output` until the browser closes the pipe. */
export async function serve({ settings, name, origin, input, output, actions = answers }) {
  let held = Buffer.alloc(0);
  for await (const chunk of input) {
    held = Buffer.concat([held, chunk]);
    while (held.length >= 4) {
      const size = held.readUInt32LE(0);
      if (size > settings.most_message_bytes) return;
      if (held.length < 4 + size) break;
      let message = null;
      try { message = JSON.parse(held.subarray(4, 4 + size).toString('utf8')); } catch { /* answered as an unknown action */ }
      held = held.subarray(4 + size);
      output.write(frame(await answerMessage({ settings, name, origin, message, actions })));
    }
  }
}

// Started by the browser through the launcher offer-in-browsers.mjs writes: argv is [host name, caller origin, ...].
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const settings = JSON.parse(readFileSync(join(HERE, 'offer-in-browsers.json'), 'utf8'));
  await serve({ settings, name: process.argv[2], origin: process.argv[3], input: process.stdin, output: process.stdout });
}
