// tools/pull-from-connected-accounts/read-data/pointer.mjs
//
// How a source description reads a service's answers. A pointer is an RFC 6901 JSON pointer ("/a/b/0", or "" for the
// whole value). An expression is what a description writes where it needs one value out of an item:
//
//   "/chat/id"                           the value at that pointer in the item
//   { "var": "channel" }                 a value bound by an earlier request of the walk
//   { "text": "General" }                a fixed word
//   { "template": "#{name} - {guild}" }  words with the bound values filled in
//   { "join": [expr, ...], "sep": " " }  the parts that are there, joined; nothing when none is there
//   { "prefix": "@", "of": expr }        the prefix and the value; nothing when the value is not there
//   { "first": [expr, ...] }             the first one that is there
//
// An expression gives text, or undefined when nothing is there (a missing value, null, or only spaces).

/** The value at `pointer` inside `value`, or undefined. */
export function at(value, pointer) {
  if (pointer === '' || pointer === undefined) return value;
  let here = value;
  for (const part of pointer.split('/').slice(1)) {
    if (here === null || typeof here !== 'object') return undefined;
    here = here[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return here;
}

/** True when the value says something: not missing, not null, not only spaces. */
export const isThere = value => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');

const asText = value => (isThere(value) && typeof value !== 'object' ? String(value) : undefined);

/** Words with each {name} replaced by the bound value; a name nothing is bound to becomes nothing. */
export function fill(template, vars) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => asText(vars[name]) ?? '');
}

/** One text out of an expression, for an item and the values bound so far. */
export function evaluate(expression, { item, vars = {} } = {}) {
  if (typeof expression === 'string') return asText(at(item, expression));
  if (expression === null || typeof expression !== 'object') return undefined;
  if ('var' in expression) return asText(vars[expression.var]);
  if ('text' in expression) return asText(expression.text);
  if ('template' in expression) return asText(fill(expression.template, vars));
  if ('join' in expression) {
    const parts = expression.join.map(part => evaluate(part, { item, vars })).filter(isThere);
    return parts.length ? parts.join(expression.sep ?? ' ') : undefined;
  }
  if ('prefix' in expression) {
    const inner = evaluate(expression.of, { item, vars });
    return isThere(inner) ? `${expression.prefix}${inner}` : undefined;
  }
  if ('first' in expression) {
    for (const option of expression.first) {
      const found = evaluate(option, { item, vars });
      if (isThere(found)) return found;
    }
  }
  return undefined;
}
