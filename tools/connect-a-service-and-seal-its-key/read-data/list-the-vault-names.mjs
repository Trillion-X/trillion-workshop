// What the vault holds, by name, without reading out a single value.
//
// Usage: node list-the-vault-names.mjs [pattern]
//   No pattern: every held name, one per line.
//   A pattern (a case-insensitive regular expression): each matching name with the
//   field names it keeps. Both come from the vault's names answer, which carries no value.

import { namesHeldByTheVault, shapeHeldByTheVault } from './ask-the-vault-for-one-secret.mjs';

const pattern = process.argv[2];
// Filter the metadata list before asking about any value's fields. The legacy all-shapes answer resolved every
// holder before this filter and could spend minutes waiting for unrelated secret-read handles to refill.
const names = await namesHeldByTheVault();

if (!pattern) {
  for (const name of names) console.log(name);
} else {
  const wanted = new RegExp(pattern, 'i');
  for (const name of names.filter((each) => wanted.test(each))) {
    const shape = shapeHeldByTheVault(name);
    const fields = Array.isArray(shape?.fields) ? shape.fields.join(', ') : `(one ${shape} value)`;
    console.log(`${name}: ${fields}`);
  }
}
