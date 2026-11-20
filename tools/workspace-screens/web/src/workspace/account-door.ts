// src/workspace/account-door.ts
//
// PURPOSE
//   Where this page's reads are answered when no Worker serves it: the account's one door. An address of the door's own
//   form (account-door.json `form`: /work/api/door/<method>, the input as ?input= or as the body, the request key as its
//   idempotency-key header) is one call of do_one_thing_in_my_account at this page's own /mcp with the page's pass, the
//   same call any AI makes. Every other address was a retired Worker's route: it is answered as no owner (api.ts), so a
//   screen says that part is not here, never a made-up answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a method, a tool or a record: the method is the address's own.
//   2. The pass is the page's (account-pass.ts); a pass the door refuses is dropped and the call asked once more.
//   3. No call waits longer than account-door.json `most_ms` for its whole answer (invariant of api.ts READ_MOST_MS).

import door from './account-door.json' with { type: 'json' };
import { pass, passRefused } from './account-pass';
import type { PageAnswer } from './api';

type Call = { method: string; request_key: string; input: unknown; pins?: string[] };

export function callOf(path: string, init: RequestInit): Call | null {
  const address = new URL(path, location.origin);
  if (!address.pathname.startsWith(door.form)) return null;
  const given = typeof init.body === 'string' ? init.body : address.searchParams.get('input');
  // `?computer=<id>` names the one of the person's computers this call is for: the engine's tools/call sends it there only
  // (`pins`). No computer named, the call is sent as it always was.
  const computer = address.searchParams.get('computer');
  return {
    method: decodeURIComponent(address.pathname.slice(door.form.length)),
    request_key: new Headers(init.headers).get('idempotency-key') ?? crypto.randomUUID(),
    input: given ? JSON.parse(given) : {},
    ...(computer ? { pins: [computer] } : {}),
  };
}

// One call waits at most door.most_ms for the whole answer: past it the call is stopped as a TimeoutError (api.ts says
// it as slow). A caller's own stop still stops it. Built by hand, since AbortSignal.any is missing in older web views.
function within(signal?: AbortSignal | null): AbortSignal {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new DOMException('The door did not answer in time.', 'TimeoutError')), door.most_ms);
  stop.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  if (signal?.aborted) stop.abort(signal.reason);
  else signal?.addEventListener('abort', () => stop.abort(signal.reason), { once: true });
  return stop.signal;
}

const ask = async (call: Call, signal: AbortSignal) => fetch(door.route, {
  method: 'POST', signal,
  // MCP over HTTP refuses (406) a caller that does not take both: the door may answer as one event (2025-06-18 transports).
  headers: { authorization: `Bearer ${await pass()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: door.tool, arguments: call } }),
});

// The reply is JSON, or an event stream whose message with this call's id is the reply (WHATWG HTML 9.2: `data:` lines).
async function replyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) return JSON.parse(text);
  const messages = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'))
    .filter(Boolean).map(data => JSON.parse(data) as { id?: unknown });
  return messages.find(message => message.id === 1) ?? null;
}

/** The door's answer to one read, in the shape every read of the page takes (api.ts PageAnswer). */
export async function answerAtTheDoor(path: string, init: RequestInit): Promise<PageAnswer> {
  const call = callOf(path, init);
  if (!call) return { status: 404, body: { failure_code: 'no-owner' } };
  const signal = within(init.signal);
  let response = await ask(call, signal);
  if (response.status === 401) { passRefused(); response = await ask(call, signal); }
  const reply = await replyOf(response).catch((error: unknown) => { if (signal.aborted) throw error; return null; }) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { message?: string } } | null;
  if (!response.ok || !reply) return { status: response.status || 503, body: null };
  if (reply.error) return { status: 400, body: { error: reply.error.message } };
  const result = reply.result ?? {};
  // A refusal keeps the door's own fields (its code, cause and detail) beside its words.
  // The engine's refusal code is also `refused.code`, where api.ts's readJson hands it to the screen that asked.
  const code = result.structuredContent?.code;
  if (result.isError) return { status: 400, body: { ...result.structuredContent, error: result.structuredContent?.message ?? result.content?.[0]?.text, ...(typeof code === 'string' ? { refused: { code } } : {}) } };
  return { status: 200, body: result.structuredContent ?? null };
}
