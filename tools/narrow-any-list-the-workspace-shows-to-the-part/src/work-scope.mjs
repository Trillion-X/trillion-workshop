// src/work-scope.mjs
//
// PURPOSE
//   Every list answer the workspace reads is narrowed by the account's scope owner (src/record-scope.mjs) when it is
//   asked for with a `scope` parameter. The scope routes below are answered by scope:request in the account's own
//   records resource (src/native-owner-routes.json), reached through the Worker's own-consumer mount.
//   Which answers take a scope, where their rows are and how a row names its record are DATA (src/record-scope.json
//   `lists`), so a screen's list gains the filter with one row there and no code here.
//
//   GET  /work/api/scope?scope=<json>&kinds=&after=&limit=    records in a scope, per kind
//   GET  /work/api/scope/values                              the pursuits and spaces that can be chosen, with counts
//   GET  /work/api/scope/record?record=<ref>                 one record's pursuits and spaces, and why
//   POST /work/api/scope/record                              { record, add?, remove? }   the person's own choice
//   GET  /work/api/scope/views, POST /work/api/scope/views    the saved global scope and each screen's own
//   GET  <any list in record-scope.json lists>?scope=<json>  the list's own answer with only the rows in the scope,
//                                                            and `scope`: the scope it was narrowed by
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here decides anything: which rows stay is the scope owner's own answer (POST /scope/match).
//   2. A list is read exactly as without a scope, then narrowed; its own page cursors are kept, so a narrowed page can
//      hold fewer rows than asked and the next page continues where the list's own did.
//   3. Writes come only from this service's own pages (the origin check every /work/api write makes).
//
import scopeData from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-scope.json' with { type: 'json' };

const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);

// The DATA list row an address matches, with the values of its { param } segments.
function listAt(pathname) {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  for (const list of scopeData.lists) {
    if (list.path.length !== segments.length) continue;
    const params = {};
    if (list.path.every((part, at) => (typeof part === 'string' ? part === segments[at] : ((params[part.param] = segments[at]), true)))) return { list, params };
  }
  return null;
}

/** A list read with a scope: the same request without it, and what narrows its answer; null for anything else. */
export function scopedList(request, url) {
  if (request.method !== 'GET' || !url.searchParams.has('scope')) return null;
  const found = listAt(url.pathname);
  if (!found) return null;
  const inner = new URL(url);
  const scope = inner.searchParams.get('scope');
  inner.searchParams.delete('scope');
  return { ...found, scope, url: inner, request: new Request(inner, request) };
}

// How one row names its record (record-scope.json lists `ref`), or null when it names none.
function refOfRow(row, ref) {
  const value = pick(row, ref.path) ?? (ref.or_path ? pick(row, ref.or_path) : undefined);
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!id) return null;
  if (ref.prefix_by) return `${ref.prefix_by.prefixes[pick(row, ref.prefix_by.field)] ?? ''}${id}`;
  return `${ref.prefix ?? ''}${id}`;
}

/** The list's answer with only the rows in the scope (invariant 1: the scope owner decides). `matcher.fetch` answers
 *  POST /scope/match (the Worker hands it the account's own records resource). */
export async function narrowList(answered, { list, params, scope }, matcher) {
  if (!answered.ok) return answered;
  let chosen;
  try { chosen = JSON.parse(scope); } catch { return Response.json({ error: scopeData.refused.bad_scope }, { status: 400 }); }
  const body = await answered.json();
  const places = list.rows.map(rows => ({ rows, found: pick(body, rows.at) })).filter(place => Array.isArray(place.found));
  const spaceOf = (row, inSpace) => (!inSpace ? null : inSpace.param ? params[inSpace.param] : (typeof pick(row, inSpace.path) === 'string' ? pick(row, inSpace.path) : null));
  const asked = places.flatMap(({ rows, found }) => found.map(row => ({ ref: refOfRow(row, rows.ref), in_space: spaceOf(row, rows.in_space) })));
  const matched = await matcher.fetch(new Request('https://person/scope/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: chosen, rows: asked }) }));
  const answer = await matched.json();
  if (!matched.ok) return Response.json(answer, { status: matched.status });
  let at = 0;
  for (const { rows, found } of places) {
    const kept = found.filter(() => answer.keep[at++]);
    let target = body;
    for (const key of rows.at.slice(0, -1)) target = target[key];
    target[rows.at.at(-1)] = kept;
  }
  return Response.json({ ...body, scope: answer.scope });
}
