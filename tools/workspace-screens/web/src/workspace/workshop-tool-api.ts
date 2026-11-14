// src/workspace/workshop-tool-api.ts
//
// The one owner of a page's Workshop tool run: POST /work/api/door/tools:run on the engine, the same run an AI starts
// with run_tool. Every screen that runs a tool (a tool's own screen, mail, sharing, needs-you, menus, list actions,
// the Make panel, Copy a site) runs it through here, so the request key, the paging of a large answer and a failed
// run's words are said once.
//
// The engine takes only `tool`, `input` and `after_byte` in the body and the run's key in the idempotency-key header;
// any other field is refused. A run is synchronous: it answers `{tool, exit_code, result, replayed, files?}` once it
// finished, or `{tool, exit_code, error, replayed}` when the tool failed, which is thrown here in the tool's own words.
// A refusal (no page grant, a reused key) is a 4xx readJson already throws. An answer too large for one page comes as
// `{byte_page: {total, blake3, offset, length, base64, next_after_byte}}`; the next page is the same call under the
// same key with `after_byte`, answered from the run's receipt, never a second run. The joined bytes are checked
// against `total` and the first page's BLAKE3 before they are read.
//
// A mail tool bound to one connected account takes it in its input as `connection` (src/workspace/mail-accounts.ts).

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readJson } from './api.ts';
import failureWords from './failure-words.json' with { type: 'json' };

export const TOOL_RUN_PATH = '/work/api/door/tools:run';

export type Ran<T = unknown> = { tool: string; exit_code: number; result?: T; files?: unknown; replayed?: boolean; error?: string };
export type BytePage = { byte_page: { total: number; blake3: string; offset: number; length: number; base64: string; next_after_byte: number | null } };

/** A fresh key for one run; the same key sent again is the same run. */
export function newRunKey(prefix = 'screen'): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/** The request one run sends: the tool, its input, the page after a byte when continuing a large answer. */
export function toolRunRequest(tool: string, input: unknown, requestKey: string, afterByte?: number): { path: string; init: RequestInit } {
  return {
    path: TOOL_RUN_PATH,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
      body: JSON.stringify(afterByte === undefined ? { tool, input } : { tool, input, after_byte: afterByte }),
    },
  };
}

function bytesOf(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
  return bytes;
}

async function wholeAnswer<T>(tool: string, input: unknown, requestKey: string, first: BytePage): Promise<Ran<T>> {
  const parts: Uint8Array[] = [bytesOf(first.byte_page.base64)];
  let next = first.byte_page.next_after_byte;
  while (next !== null) {
    const request = toolRunRequest(tool, input, requestKey, next);
    const page = await readJson<BytePage>(request.path, request.init, true);
    if (page.byte_page?.blake3 !== first.byte_page.blake3) throw new Error(failureWords.broke);
    parts.push(bytesOf(page.byte_page.base64));
    next = page.byte_page.next_after_byte;
  }
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  parts.reduce((at, part) => (joined.set(part, at), at + part.length), 0);
  if (joined.length !== first.byte_page.total || bytesToHex(blake3(joined)) !== first.byte_page.blake3) throw new Error(failureWords.broke);
  return JSON.parse(new TextDecoder().decode(joined)) as Ran<T>;
}

/** The whole run from its first answer: a byte-paged answer is read to its last page under the same key and checked. */
export async function finishRun<T = unknown>(tool: string, input: unknown, requestKey: string, answer: Ran<T> | BytePage): Promise<Ran<T>> {
  return 'byte_page' in answer ? wholeAnswer<T>(tool, input, requestKey, answer) : answer;
}

/** Run one tool in the signed-in person's account and answer its finished run. Pass requestKey to retry a known run
 *  without doing it twice; a run the engine answers busy is sent again under the same key by itself. A failed run
 *  throws with the tool's own words. */
export async function runWorkshopTool<T = unknown>(tool: string, input: unknown = {}, requestKey = newRunKey('screen')): Promise<Ran<T>> {
  const request = toolRunRequest(tool, input, requestKey);
  const ran = await finishRun<T>(tool, input, requestKey, await readJson<Ran<T> | BytePage>(request.path, request.init, true));
  if (ran.exit_code !== 0) throw Object.assign(new Error(ran.error?.trim() || failureWords.refused), { ran });
  return ran;
}
