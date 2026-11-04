// src/native-owner-routes.mjs
//
// PURPOSE
//   Account routes whose owner is mounted in the account's own records resource (src/native-owner-routes.json): which
//   family a route belongs to, the <family>:request operation it becomes, and the native answer, which is that family's
//   own HTTP handler run over its mounted owner, so the route behaves exactly as it always has.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The families are DATA; adding one is a row in the JSON and its handler bound where the owner is mounted.
//   2. A failure that tries again later (src/failure.mjs tries_again_later) is never turned into a refusal here: each
//      family's handler throws it, and it reaches the shared HTTP failure owner.

import ownerRoutes from './native-owner-routes.json' with { type: 'json' };

// The rows whose owner is mounted in the account's own records resource; a row with `host` runs elsewhere.
const resourceRows = ownerRoutes.families.filter(row => !row.host);
export const ownerRouteFamilies = () => resourceRows.map(row => row.family);

/** The route table's entry for this account route ({ family, host?, ... }), or null. */
export const ownerRouteEntry = (path, method = null) => ownerRoutes.families.find(row =>
  (method === null || !row.methods || row.methods.includes(method))
  && (row.exact.includes(path) || row.prefix.some(prefix => path.startsWith(prefix)))) ?? null;

/** The family whose mounted owner answers this account route, or null. */
export const ownerRouteFamily = (path, method = null) => ownerRouteEntry(path, method)?.family ?? null;

export const isOwnerRouteOperation = operation => resourceRows.some(row => operation === `${row.family}:request`);

/** The <family>:request command for an account route ([operation, { path, method, body }]), or null when no family owns it.
 *  A row's addressed entries name another spelling of a route (the browser reads one interface as GET /controls/<id>). */
export function ownerRouteCommand(path, method, body, query = {}) {
  for (const row of resourceRows) for (const entry of row.addressed ?? []) {
    const rest = path.startsWith(entry.prefix) ? decodeURIComponent(path.slice(entry.prefix.length)) : '';
    if (method === entry.method && rest && !rest.includes('/') && !row.exact.includes(path)) {
      return [`${row.family}:request`, { path: entry.to_path, method: entry.to_method, body: { [entry.rest_field]: rest } }];
    }
  }
  const entry = ownerRouteEntry(path, method);
  if (!entry || entry.host) return null;
  return [`${entry.family}:request`, { path: path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''), method, body: body ?? {} }];
}

/** The native answer to one <family>:request: the family's handler over its owner, as a native response envelope. */
export async function answerOwnerRoute(handle, owner, input) {
  const method = input.method ?? 'GET';
  const response = await handle(owner, new Request(new URL(input.path, 'https://app.gettrillion.ai'), {
    method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(input.body ?? {}) }),
  }));
  return { native_response: true, status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
}

/** A native answer a scheduled run took as its result: an envelope that answered a failure (4xx or 5xx) is thrown as that
 *  run's failure, so the scheduler backs the run off (src/scheduler.mjs invariant 4) instead of counting it done. */
export function settledAnswer(operation, answer) {
  if (answer?.native_response && answer.status >= 400)
    throw Object.assign(new Error(`${operation} answered ${answer.status}: ${String(answer.body?.error ?? '').slice(0, 200)}`), { status: answer.status });
  return answer;
}
