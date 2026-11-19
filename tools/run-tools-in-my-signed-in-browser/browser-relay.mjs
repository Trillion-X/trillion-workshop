// tools/run-tools-in-my-signed-in-browser/browser-relay.mjs
//
// PURPOSE
//   Lets a tool run on this computer reach the person's own signed-in browser. While the extension holds its native
//   messaging connection to the host open, the host calls `open()`: it listens on the loopback port this computer's own
//   report names under `port_name` (`readPort`; the number has that one home), passes each request { tool, input, request_key } to the extension over that open connection as
//   { relay: { request_key, tool, input } }, and answers the caller with what the extension returns as
//   { relay_answer: { request_key, result | error } }. The tool rows (ask-my-browser.mjs) reach this port by name,
//   `invoke.local_doors`, as any computer tool reaches a local server.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It listens on the loopback address only, answers only the Host it listens
//      on (a web page cannot reach it through a name that resolves here), refuses any request that carries an Origin
//      (a web page's own request) and any body that is not application/json (which a web page cannot send without a
//      preflight this door never answers).
//   2. Only a run the engine started for this person asks: every request carries a single-use nonce this door issued and an
//      Ed25519 signature of it, made inside the person's vault (`secrets:sign`), checked against the key's public half.
//      A request without a good proof is refused before the extension is told of it. Only the tools browser-relay.json lists are passed on; the request names no other call.
//   3. Bounded: the request body, the browser's answer, the requests waiting and the wait are DATA limits. A request
//      past a limit is refused in words, never cut.
//   4. With no browser connected the caller is refused at once in words (`no_browser`), and a request whose browser
//      leaves is finished with `browser_left`: no request waits for nothing.
//   5. One browser holds the door at a time; a second browser's `open()` is refused in words (`held`).
//   6. Nothing listens on a port the computer does not report under `port_name` (`no_port`). The public half of the vault
//      key `key_name` is asked of the vault at each `open()` and, while the vault holds none, again at each challenge; until
//      then every caller is refused in the `not_set_up` words, which name the workflow that makes the key.
import { createServer } from 'node:http';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const refusal = (status, message) => Object.assign(new Error(message), { status });

/** The relay for one connection to one browser: `send(message)` writes a framed message to that browser. */
export function makeRelay({ config, send, readPort = () => null, readPublicKey = async () => null, now = () => Date.now() }) {
  const pending = new Map();
  const nonces = new Map();
  let server = null;
  let publicHex = null;

  const finishAll = message => {
    for (const [key, waiting] of pending) { clearTimeout(waiting.timer); waiting.reject(refusal(502, message)); pending.delete(key); }
  };

  /** The key's public half from the vault, or null when it holds none. */
  const known = async () => { try { const hex = await readPublicKey(); return typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? hex : null; } catch { return null; } };

  const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const wording = { key: config.key_name, name: config.port_name, path: config.challenge_path };

  /** A fresh nonce, good once for `challenge_seconds`; refused in words when no key is set up. */
  async function challenge() {
    publicHex ??= await known();
    if (!publicHex) throw refusal(503, fill(config.words.not_set_up, wording));
    for (const [nonce, until] of nonces) if (until <= now()) nonces.delete(nonce);
    if (nonces.size >= config.most_challenges) throw refusal(429, fill(config.words.busy, { count: nonces.size }));
    const nonce = randomBytes(32).toString('hex');
    nonces.set(nonce, now() + config.challenge_seconds * 1000);
    return { nonce, seconds: config.challenge_seconds };
  }

  /** Checks the proof of one request and spends its nonce, whether or not the proof is good. */
  function prove(given) {
    const hex = publicHex;
    if (!hex) throw refusal(503, fill(config.words.not_set_up, wording));
    const { nonce, signature } = given;
    if (typeof nonce !== 'string' || typeof signature !== 'string') throw refusal(401, fill(config.words.no_proof, wording));
    const until = nonces.get(nonce);
    nonces.delete(nonce);
    let good = false;
    try {
      const key = createPublicKey({ key: Buffer.concat([ED25519_DER_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
      good = until !== undefined && until > now() && /^[0-9a-f]{128}$/.test(signature)
        && verify(null, Buffer.from(`${nonce}\n${given.tool}\n${JSON.stringify(given.input ?? {})}`, 'utf8'), key, Buffer.from(signature, 'hex'));
    } catch { good = false; }
    if (!good) throw refusal(401, fill(config.words.bad_proof, wording));
  }

  /** Passes one request to the browser and waits for its answer. */
  function ask({ tool, input, request_key }) {
    if (typeof tool !== 'string' || !config.tools.includes(tool)) throw refusal(404, fill(config.words.not_kept, { tool }));
    if (pending.size >= config.most_waiting) throw refusal(429, fill(config.words.busy, { count: pending.size }));
    const key = typeof request_key === 'string' && request_key ? request_key : randomUUID();
    if (pending.has(key)) throw refusal(409, fill(config.words.busy, { count: pending.size }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(refusal(504, fill(config.words.too_slow, { seconds: config.most_seconds }))); }, config.most_seconds * 1000);
      pending.set(key, { resolve, reject, timer });
      send({ relay: { request_key: key, tool, input: input ?? {} } });
    });
  }

  /** The browser's answer to one request. An answer for a request no longer waiting is dropped. */
  function answer(message) {
    const given = message?.relay_answer;
    const waiting = typeof given?.request_key === 'string' ? pending.get(given.request_key) : undefined;
    if (!waiting) return;
    pending.delete(given.request_key);
    clearTimeout(waiting.timer);
    if (typeof given.error === 'string' && given.error) { waiting.reject(refusal(422, given.error)); return; }
    const text = JSON.stringify({ result: given.result ?? null });
    if (Buffer.byteLength(text) > config.most_answer_bytes) waiting.reject(refusal(413, fill(config.words.too_large_answer, { bytes: config.most_answer_bytes })));
    else waiting.resolve(text);
  }

  async function handle(request, response) {
    const reply = (status, body) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };
    try {
      const here = `${config.host}:${server.address().port}`;
      if (request.method !== 'POST' || (request.url !== config.path && request.url !== config.challenge_path) || request.headers.host !== here || request.headers.origin !== undefined)
        throw refusal(404, fill(config.words.not_here, { path: config.path }));
      if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) throw refusal(415, config.words.not_json);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > config.most_request_bytes) throw refusal(413, fill(config.words.too_large_request, { bytes: config.most_request_bytes }));
        chunks.push(chunk);
      }
      let given;
      try { given = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw refusal(400, config.words.not_json); }
      if (!given || typeof given !== 'object' || Array.isArray(given)) throw refusal(400, config.words.not_json);
      if (request.url === config.challenge_path) { reply(200, await challenge()); return; }
      prove(given);
      reply(200, await ask(given));
    } catch (error) {
      reply(error.status ?? 500, { error: String(error?.message ?? error).slice(0, 2000) });
    }
  }

  return {
    ask,
    answer,
    /** Starts listening on the reported port, with the key's public half as the vault answers it now; refused in words when no port is reported. */
    open: async () => {
      if (server) return { port_name: config.port_name, port: server.address().port };
      const port = readPort();
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(fill(config.words.no_port, wording));
      publicHex = await known();
      return new Promise((resolve, reject) => {
        const listening = createServer((request, response) => { handle(request, response); });
        listening.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(config.words.held) : error));
        listening.listen(port, config.host, () => { server = listening; resolve({ port_name: config.port_name, port }); });
      });
    },
    /** Stops listening and finishes every waiting request: the browser has gone. */
    close: () => {
      finishAll(config.words.browser_left);
      server?.close();
      server?.closeIdleConnections?.();
      server = null;
      publicHex = null;
    },
    most_answer_bytes: config.most_answer_bytes,
    get open_now() { return server !== null; },
  };
}
