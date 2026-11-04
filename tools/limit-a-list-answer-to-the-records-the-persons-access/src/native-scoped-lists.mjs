// Apply the existing record-scope DATA to a native list answer. The caller
// supplies the already-authorized native scope owner; this module never
// forwards to PersonStore or chooses scope membership itself.
import scopeData from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-scope.json' with { type: 'json' };

const pick = (value, path) => path.reduce((at, key) => at && typeof at === 'object' ? at[key] : undefined, value);

/** Match one configured /work/api list address and collect its path parameters. */
export function nativeScopedListAddress(pathname) {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  for (const list of scopeData.lists) {
    if (list.path.length !== segments.length) continue;
    const params = {};
    if (list.path.every((part, at) => typeof part === 'string'
      ? part === segments[at]
      : (params[part.param] = segments[at], true))) return { list, params };
  }
  return null;
}

function refOfRow(row, ref) {
  const value = pick(row, ref.path) ?? (ref.or_path ? pick(row, ref.or_path) : undefined);
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!id) return null;
  if (ref.prefix_by) return `${ref.prefix_by.prefixes[pick(row, ref.prefix_by.field)] ?? ''}${id}`;
  return `${ref.prefix ?? ''}${id}`;
}

/**
 * Narrow a native list's already-computed answer by calling the real scope
 * owner with the references declared in record-scope.json. Pagination and all
 * other list fields remain the underlying list's answer, as on the source
 * work-scope road.
 */
export async function narrowNativeScopedList(answer, { pathname, scope }, matchScope) {
  const found = nativeScopedListAddress(pathname);
  if (!found || scope === undefined || scope === null) return answer;
  if (!answer || answer.ok === false || (answer.native_response && answer.status >= 400)) return answer;
  if (typeof matchScope !== 'function') throw new TypeError('The native scope owner is required to narrow a scoped list.');
  const wrapped = answer.native_response === true;
  const original = wrapped ? answer.body : answer;
  const body = original instanceof Response ? await original.clone().json() : structuredClone(original);
  const places = found.list.rows.map(row => ({ config: row, rows: pick(body, row.at) }))
    .filter(place => Array.isArray(place.rows));
  const candidates = places.flatMap(({ config, rows }) => rows.map(row => ({
    ref: refOfRow(row, config.ref),
    in_space: config.in_space ? (config.in_space.param
      ? found.params[config.in_space.param]
      : typeof pick(row, config.in_space.path) === 'string' ? pick(row, config.in_space.path) : null) : null,
  })));
  const matched = await matchScope({ scope: typeof scope === 'string' ? JSON.parse(scope) : scope, rows: candidates });
  if(!Array.isArray(matched?.keep)||matched.keep.length!==candidates.length||matched.keep.some(value=>typeof value!=='boolean'))throw new Error('The canonical scope matcher did not answer every list row.');
  let at = 0;
  for (const { config, rows } of places) {
    const kept = rows.filter(() => matched.keep[at++]);
    let target = body;
    for (const key of config.at.slice(0, -1)) target = target[key];
    target[config.at.at(-1)] = kept;
  }
  body.scope = matched.scope;
  if (wrapped) return { ...answer, body };
  if (answer instanceof Response) return Response.json(body, { status: answer.status, headers: answer.headers });
  return body;
}

/** Resolve a list address and run its native list reader before narrowing. */
export async function readNativeScopedList({ pathname, scope, read }, matchScope) {
  const found = nativeScopedListAddress(pathname);
  if (!found || typeof read !== 'function') throw new TypeError('A configured native list address and reader are required.');
  const answer = await read();
  return narrowNativeScopedList(answer, { pathname, scope }, matchScope);
}
