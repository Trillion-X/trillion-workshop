// src/workspace/pursuit-list.mjs
//
// PURPOSE
//   The person's pursuits, as the vault names them: each connection whose name ends with focus.json `pursuits.runs_suffix`
//   is one pursuit. Its id is the name without the suffix, its title that id in words. The sidebar's pursuit rows
//   (screen-catalog.mjs) and the focus switcher (scope-focus.ts) both read the pursuits here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names only: the answer read is the vault's names, never a value.
//   2. The suffix is focus.json DATA; nothing here names a pursuit.
import focusWords from './focus.json' with { type: 'json' };

const suffix = focusWords.pursuits.runs_suffix;

/** → [{ id, title, connection }] for the names that are pursuits, in name order. */
export function pursuitsFromNames(names) {
  return names.filter(name => name.endsWith(suffix)).sort().map(connection => {
    const id = connection.slice(0, -suffix.length);
    const plain = id.replace(/_/g, ' ');
    return { id, title: plain.charAt(0).toUpperCase() + plain.slice(1), connection };
  });
}
