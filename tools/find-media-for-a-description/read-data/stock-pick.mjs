// Pure readers for a stock library's answer. A source row (stock-sources.json) says where the file address is; nothing
// here names a library.

/** The value at a dotted path: a name picks a field, a number picks an array item. undefined when the path is not there. */
export function valueAt(node, path) {
  let here = node;
  for (const step of String(path).split('.')) {
    if (here === null || typeof here !== 'object') return undefined;
    here = here[/^\d+$/.test(step) ? Number(step) : step];
  }
  return here;
}

/** The file address an answer holds, by one `pick` rule ({ at, largest_by?, url: [paths] }), or null when it holds none. */
export function pickUrl(answer, pick) {
  let node = valueAt(answer, pick.at);
  if (Array.isArray(node)) {
    node = pick.largest_by
      ? [...node].sort((left, right) => (Number(right?.[pick.largest_by]) || 0) - (Number(left?.[pick.largest_by]) || 0))[0]
      : node[0];
  }
  for (const path of pick.url) {
    const found = valueAt(node, path);
    if (typeof found === 'string' && found) return found;
  }
  return null;
}

/** A search address from a template: {query} is the words, encoded; {key} is the person's key for it. */
export function searchUrl(template, query, key) {
  return template.replace('{query}', encodeURIComponent(query)).replace('{key}', encodeURIComponent(key));
}
