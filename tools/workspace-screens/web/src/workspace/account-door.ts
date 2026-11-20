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

import door from './account-door.json' with { type: 'json' };
import { pass, passRefused } from './account-pass';
import type { PageAnswer } from './api';

type Call = { method: string; request_key: string; input: unknown };

function callOf(path: string, init: RequestInit): Call | null {
  const address = new URL(path, location.origin);
  if (!address.pathname.startsWith(door.form)) return null;
  const given = typeof init.body === 'string' ? init.body : address.searchParams.get('input');
  return {
    method: decodeURIComponent(address.pathname.slice(door.form.length)),
    request_key: new Headers(init.headers).get('idempotency-key') ?? crypto.randomUUID(),
    input: given ? JSON.parse(given) : {},
  };
}

const ask = async (call: Call, signal?: AbortSignal | null) => fetch(door.route, {
  method: 'POST', signal: signal ?? null,
  headers: { authorization: `Bearer ${await pass()}`, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: door.tool, arguments: call } }),
});

/** The door's answer to one read, in the shape every read of the page takes (api.ts PageAnswer). */
export async function answerAtTheDoor(path: string, init: RequestInit): Promise<PageAnswer> {
  const call = callOf(path, init);
  if (!call) return { status: 404, body: { failure_code: 'no-owner' } };
  let response = await ask(call, init.signal);
  if (response.status === 401) { passRefused(); response = await ask(call, init.signal); }
  const reply = await response.json().catch(() => null) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { message?: string } } | null;
  if (!response.ok || !reply) return { status: response.status || 503, body: null };
  if (reply.error) return { status: 400, body: { error: reply.error.message } };
  const result = reply.result ?? {};
  // A refusal keeps the door's own fields (its code, cause and detail) beside its words.
  if (result.isError) return { status: 400, body: { ...result.structuredContent, error: result.structuredContent?.message ?? result.content?.[0]?.text } };
  return { status: 200, body: result.structuredContent ?? null };
}
