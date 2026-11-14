/**
 * lib/template.mjs — the ONE payload-template substitution primitive (SSOT).
 *
 * Extracted (W1b) from the byte-identical copies in sweep-decisions-once.mjs and
 * materialize-pending-once.mjs (violation V14 — a pure function duplicated across two
 * process scripts). Both now import this. Zero I/O, zero package awareness — pure data.
 *
 * Grammar (machine-readable, dumb-JSON-parser test passes):
 *   - a STRING value that starts with a single "$" is replaced by item[<name-after-$>] ?? null
 *   - "$$..." is an ESCAPE → a literal string with one leading "$" ("$$x" -> "$x")
 *   - an OBJECT or ARRAY is recursed (so nested templates like {topic:{topic:"$keyword"}} work)
 *   - every other value is a literal
 *
 * RECURSIVE by design: the flat owner-map templates ({body_text:"$artifact",content_type:"text/markdown"})
 * produce byte-identical output to the old shallow version (behavior-preserving for every live row),
 * while nested descriptors (the article. row's {topic:{topic:"$keyword",query:"$keyword",slug:"$slug"}})
 * now substitute at any depth. The engine stays blind — it never names a field; the descriptor DATA does.
 */
export function fillTemplate(template, item) {
  if (!item || typeof item !== 'object') return null;
  return substitute(template, item);
}

function substitute(node, item) {
  if (typeof node === 'string') {
    if (node.startsWith('$$')) return '$' + node.slice(2); // escape → literal leading $
    if (node.startsWith('$')) return item[node.slice(1)] ?? null;
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => substitute(v, item));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, item);
    return out;
  }
  return node; // number / boolean / null literal
}

// Back-compat alias: the old name used across the codebase + tests. Same function, recursive.
export const buildPayloadFromTemplate = fillTemplate;
