// tools/workspace-screens/web/members-page/host.ts
//
// PURPOSE
//   The members page's connection to its host: the addresses the host answers on, read from the page's own host block
//   (index.html, `#members-host`), and the transports the records source and the records door read and write through.
//   The host is the site's program; it answers for the signed-in person only, and a request without a session is answered
//   401, which sends the page to the sign-in the host names.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every address comes from the host block; nothing here names a site.
//   2. A 401 is not retried: the page goes to the sign-in and does not draw.

import { signInAddress } from '../src/workspace/addresses.mjs';

export type HostConfig = {
  placement: string;
  subject: string;
  records: string;
  door_record: string;
  door_list: string;
  door_write: string;
  /** The host's own sign-in page; the page returns to `next` after signing in. Without one, the workspace's sign-in address. */
  sign_in?: string;
};
type Json = Record<string, unknown>;

export function readHostConfig(): HostConfig {
  const text = document.getElementById('members-host')?.textContent ?? '';
  return JSON.parse(text) as HostConfig;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error((answer as Json).error as string || 'The host did not answer.'), { status: response.status });
  return answer as T;
}

/** Who the page is for: the host's answer for the signed-in person. A person who is not signed in is sent to the sign-in. */
export async function subjectOf(host: HostConfig): Promise<Json> {
  const response = await fetch(host.subject, { cache: 'no-store' });
  if (response.status === 401) {
    const next = `${location.pathname}${location.search}`;
    location.assign(host.sign_in ? `${host.sign_in}?${new URLSearchParams({ next })}` : signInAddress(next));
    throw new Error('Sign in to see this page.');
  }
  if (!response.ok) throw new Error('The host did not say who is signed in.');
  return response.json() as Promise<Json>;
}

export function recordsTransport(host: HostConfig) {
  return {
    read: (labels: readonly string[]) => call<{ records?: Record<string, unknown> }>(`${host.records}?${new URLSearchParams(labels.map(label => ['label', label] as [string, string]))}`),
    write: (body: unknown) => call<{ written?: number; conflicts?: unknown[] }>(host.records, { method: 'POST', body: JSON.stringify(body) }),
  };
}

export function doorTransport(host: HostConfig) {
  return {
    read: (input: { id: string; type: string }) => call<{ id: string; type: string; value: Json | null }>(
      `${host.door_record}?${new URLSearchParams({ type: input.type, id: input.id })}`),
    list: (input: { type: string; prefix?: string; limit?: number; after?: string | null; where?: unknown }) => {
      const query = new URLSearchParams({ type: input.type });
      if (input.prefix) query.set('prefix', input.prefix);
      if (input.limit) query.set('limit', String(input.limit));
      if (input.after) query.set('after', input.after);
      if (input.where) query.set('where', JSON.stringify(input.where));
      return call<{ records: unknown[]; next: string | null }>(`${host.door_list}?${query}`);
    },
    write: (body: { records: unknown[] }) => call<{ changed: boolean; write_count: number }>(host.door_write, { method: 'POST', body: JSON.stringify(body) }),
  };
}
