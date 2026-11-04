// computer/browser-bridge.mjs
//
// PURPOSE
//   Joins a browser extension to this Mac the browser's own way (native messaging): `connect` installs, reads and removes the
//   manifest (computer/native-messaging.mjs) that names a small launcher, and `serve` is the program the browser starts, which
//   speaks the native-messaging frames (4-byte length, JSON) and answers each request by running one of this Mac's tools with the
//   same runner the live socket uses (computer/mac-tools.mjs runHere).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the extensions named in the call are allowed by the manifest (no wildcard); the browser, not this file, enforces which
//      extension may start the program.
//   2. Only tool ids in DATA (native-messaging.json `bridge.tools`, none by default) are run; any other request is refused in words.
//      A request can never name a module or a path.
//   3. The launcher is a file this module writes beside the person's other Trillion files (mode 0755) that runs this Mac's own node
//      on this folder's host program; a launcher it did not write is never overwritten.
//
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNativeMessaging, nativeMessagingSettings } from './native-messaging.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });
const MARK = '# written by trillion computer/browser-bridge.mjs';

/** One request frame in, one answer out: { id, tool_id, input } → { id, answer } | { id, error }. */
export async function answerFrame(frame, { settings = nativeMessagingSettings(), runHere }) {
  const id = frame?.id ?? null;
  if (!frame || typeof frame.tool_id !== 'string') return { id, error: settings.bridge.words.bad_request };
  if (!settings.bridge.tools.includes(frame.tool_id)) return { id, error: settings.bridge.words.not_allowed.replace('{tool}', frame.tool_id) };
  const answer = await runHere({ tool_id: frame.tool_id, input: frame.input ?? {} });
  return answer?.error ? { id, error: answer.error, ...(typeof answer.retry === 'boolean' ? { retry: answer.retry } : {}) } : { id, answer };
}

/** The framing: reads frames from `input` (a stream), writes answers to `output`; resolves when input ends. */
export function serve({ input, output, answer, limit }) {
  return new Promise(done => {
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve();
    const send = value => {
      const body = Buffer.from(JSON.stringify(value));
      const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
      output.write(Buffer.concat([head, body]));
    };
    input.on('data', piece => {
      pending = Buffer.concat([pending, piece]);
      while (pending.length >= 4) {
        const size = pending.readUInt32LE(0);
        if (size > limit) { send({ id: null, error: 'That message is larger than this Mac accepts.' }); pending = Buffer.alloc(0); return; }
        if (pending.length < 4 + size) return;
        const body = pending.subarray(4, 4 + size);
        pending = pending.subarray(4 + size);
        queue = queue.then(async () => {
          let frame = null;
          try { frame = JSON.parse(body.toString('utf8')); } catch { return send({ id: null, error: 'That message is not JSON.' }); }
          send(await answer(frame));
        });
      }
    });
    input.on('end', () => queue.then(done));
  });
}

export function makeBrowserBridge({ home = homedir(), settings = nativeMessagingSettings(), node = process.execPath, messaging = makeNativeMessaging({ home, settings }) } = {}) {
  const launcher = join(home, settings.bridge.launcher);
  return {
    connect({ action = 'status', extensions, browsers } = {}) {
      const name = settings.bridge.name;
      if (action === 'status') return { ...messaging.read({ name, browsers }), launcher: existsSync(launcher) ? launcher : null };
      if (action === 'remove') return messaging.remove({ name, browsers });
      if (action !== 'install') throw refusal(`There is no bridge action named ${action}. Use install, status or remove.`);
      if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes(MARK)) throw refusal(settings.bridge.words.foreign_launcher.replace('{path}', launcher), 409);
      mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
      writeFileSync(`${launcher}.next`, `#!/bin/sh\n${MARK}\nexec "${node}" "${join(HERE, 'browser-bridge.mjs')}" serve\n`, { mode: 0o755 });
      chmodSync(`${launcher}.next`, 0o755);
      renameSync(`${launcher}.next`, launcher);
      return messaging.install({ name, description: settings.bridge.description, path: launcher, extensions, browsers });
    },
  };
}

let shared = null;
export const bridgeTools = { connect: input => (shared ??= makeBrowserBridge()).connect(input ?? {}) };

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'serve') {
  const { runHere, settingsOf } = await import('./mac-tools.mjs');
  const rules = nativeMessagingSettings();
  const macSettings = settingsOf();
  await serve({ input: process.stdin, output: process.stdout, limit: rules.bridge.max_message_bytes,
    answer: frame => answerFrame(frame, { settings: rules, runHere: run => runHere(macSettings, run) }) });
}
