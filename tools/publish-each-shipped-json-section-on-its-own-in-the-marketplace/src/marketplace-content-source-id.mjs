// src/marketplace-content-source-id.mjs
//
// PURPOSE
//   The one name of a shipped JSON section's Marketplace publication: its source coordinate (a records file and a JSON
//   pointer in it). The publication owner (src/marketplace-content-section.mjs), the resolver that reads a published
//   default (src/marketplace-content-sources.mjs) and a computer that reads it through its account
//   (computer/local-models.mjs) all name a section by it. Dependency-free, so the computer's app can carry it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source coordinate is evidence, not a semantic item-kind enumeration.
//
const bounded = (value, name, maximum) => {
  if (typeof value !== 'string' || !value || value.length > maximum) throw Object.assign(new Error(`Give a bounded ${name}.`), { status: 400 });
  return value;
};

/** `source:["<file>","<pointer>"]` for a section's file and pointer (the empty pointer is the whole file). */
export function marketplaceContentSourceId({ file, pointer = '' }) {
  bounded(file, 'source file', 1000);
  if (typeof pointer !== 'string' || pointer.length > 8192 || pointer !== '' && !pointer.startsWith('/')) throw Object.assign(new Error('Give a JSON pointer or the empty root pointer.'), { status: 400 });
  return bounded(`source:${JSON.stringify([file, pointer])}`, 'source section identity', 1000);
}
