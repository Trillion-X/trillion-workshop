// tools/add-tool-source/do-work/ask-the-web.mjs
//
// Purpose: The one way tool:add-tool-source asks the web a question (its probe of an address, and the documents of a
// server's sign-in): one bounded request with no credential, following at most `max_redirects` redirects each to https,
// and a read of at most `max_bytes` of the answer. Where a request may go is the run's own egress (public addresses only).
//
//   ask(send, address, init)   -> the reply; `send` is the web's fetch, a test gives its own
//   read(reply)                -> at most `max_bytes` of its body, as text
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/add-tool-source.json' with { type: 'json' };

const { probe } = data;

/** One request, bounded, with no credential, following at most `max_redirects` redirects each to https. */
export async function ask(send, address, init) {
  let at = address;
  for (let followed = 0; ; followed += 1) {
    const reply = await send(at, { ...init, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(probe.timeout_ms) });
    const next = [301, 302, 303, 307, 308].includes(reply.status) ? reply.headers.get('location') : null;
    if (!next) return reply;
    if (followed >= probe.max_redirects) throw new Error('followed too many redirects');
    at = new URL(next, at);
    if (at.protocol !== 'https:') throw new Error('was sent to an address that is not https');
    at = at.href;
  }
}

/** At most `max_bytes` of the answer's body, as text. */
export async function read(reply) {
  const chunks = [];
  let length = 0;
  for await (const chunk of reply.body ?? []) {
    chunks.push(chunk);
    length += chunk.length;
    if (length >= probe.max_bytes) break;
  }
  return Buffer.concat(chunks).subarray(0, probe.max_bytes).toString('latin1');
}
