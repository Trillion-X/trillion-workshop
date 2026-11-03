// tools/walk-nested-input-within-limits/read-data/bounded-walk.mjs (moved from Trillion-X/trillion parts/bounded-walk.mjs)
//
// Purpose: the one guard for walking untrusted nested input (imported documents, pasted rich text, list row values from
// an AI, board scenes) with an explicit stack instead of recursion, so a deep or huge value is refused with a typed reason
// before it can crash a renderer or a store. Dependency-free, so a container, a browser and a
// computer share it.
//
//   boundedWalk(root, { children, visit, limits }) -> { ok: true, nodes } | { ok: false, reason, limit }
//   refusalWords(result)                           -> the plain words of a refusal
//
// Non-negotiable invariants
//   1. No recursion: depth costs memory in a stack the guard owns, never the call stack.
//   2. The walk stops at the first limit crossed: depth over max_depth is 'too_deep', nodes over max_nodes is
//      'too_many_nodes', a value met again while it is still being walked is 'cycle'. `visit` may refuse too, by returning
//      a reason string; the walk is then { ok: false, reason }.
//   3. The limits and words are DATA (read-data/bounded-walk.json); a caller with a tighter limit passes it in `limits`.
//
import walkData from './bounded-walk.json' with { type: 'json' };

export const walkSettings = () => walkData;

/** The children of a JSON value: an array's items or an object's values. */
export const jsonChildren = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);

export function boundedWalk(root, { children = jsonChildren, visit = () => undefined, limits = {}, settings = walkSettings() } = {}) {
  const maxDepth = limits.max_depth ?? settings.max_depth;
  const maxNodes = limits.max_nodes ?? settings.max_nodes;
  const active = new Set();
  const stack = [{ node: root, depth: 0, leave: false }];
  let nodes = 0;
  while (stack.length) {
    const { node, depth, leave } = stack.pop();
    if (leave) { active.delete(node); continue; }
    if (depth > maxDepth) return { ok: false, reason: 'too_deep', limit: maxDepth };
    nodes += 1;
    if (nodes > maxNodes) return { ok: false, reason: 'too_many_nodes', limit: maxNodes };
    const isObject = node !== null && typeof node === 'object';
    if (isObject && active.has(node)) return { ok: false, reason: 'cycle', limit: null };
    const refused = visit(node, depth);
    if (typeof refused === 'string') return { ok: false, reason: refused, limit: null };
    if (!isObject) continue;
    active.add(node);
    stack.push({ node, depth, leave: true });
    const kids = children(node);
    for (let index = kids.length - 1; index >= 0; index -= 1) stack.push({ node: kids[index], depth: depth + 1, leave: false });
  }
  return { ok: true, nodes };
}

/** The plain words of a refused walk. */
export function refusalWords(result, settings = walkSettings()) {
  return String(settings.words[result.reason] ?? result.reason).replace(/\{limit\}/g, String(result.limit ?? ''));
}

/** The tool's run: { value, limits? } on standard input -> { result: { ok, nodes } | { ok: false, reason, limit, said } }. */
export function checkNested(input = {}) {
  const result = boundedWalk(input.value ?? null, { limits: input.limits ?? {} });
  return result.ok ? result : { ...result, said: refusalWords(result) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text } = await import('node:stream/consumers');
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: checkNested(input) }));
}
