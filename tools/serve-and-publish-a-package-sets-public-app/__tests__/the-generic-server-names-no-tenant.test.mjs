// THE GENERIC SERVER NAMES NO INSTALLED TENANT, checked rather than asserted.
//
// This exists because the claim "the server holds no tenant name" was written into the lane plan
// and the knowledge index THREE times, by hand, and was FALSE every time. Each was written right
// after a large removal, which reads internally as completeness. Removal is evidence of removal.
// Only a search is evidence of absence, so the search belongs in a file that runs.
//
// The forbidden words are NOT a list. A list of tenant names would be an enum over an open set,
// and the sixth tenant would arrive without anyone adding its row. They are DERIVED from whatever
// package sets are installed: the set's own folder name, and the `brand` and `title` it declares
// in its own page description. A tenant is covered the day it is installed.
//
// Comments are stripped before checking, deliberately. Explaining a literal you removed means
// quoting it, and a guard that forbids quoting the thing it removed pushes the next person toward
// deleting the explanation instead. Same reason the prose guards carry an exemption marker.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { PACKAGE_SETS_DIR } from './built-entry-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROCESSES_DIR = join(here, '..', 'processes');

// DISCOVERED, not listed. The first version named the two files that existed the day it was
// written, which is the same closed-set defect the forbidden words avoid: a third generic source
// would arrive uncovered and this file would keep reporting clean. Every `.mjs` under processes/
// that is not itself a test is a generic source by construction.
async function genericSources() {
  const entries = await readdir(PROCESSES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')
      && !entry.name.includes('.test.') && !entry.name.includes('.spec.'))
    .map((entry) => join(PROCESSES_DIR, entry.name))
    .sort();
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `, ${detail}`}`);
  if (!ok) failures += 1;
}

// A whole-line comment only. A trailing comment after code would need a parser to find safely,
// and claiming to strip those without one would be the kind of half-true check this file exists
// to replace.
// One EXPLICIT, GREPPABLE exemption, not a silent hole. Renaming an operator-facing variable
// safely means still reading the old name, so the old name has to live somewhere; putting it in a
// marked block keeps the exemption visible in the file it exempts, exactly like the prose guards'
// SEARCHED-AND-CONFIRMED marker. An unmarked special case in this checker would have hidden the
// same fact where nobody reads it.
// PER LINE, not per block. The first version used BEGIN/END markers, which needed a second check
// that every block was closed, because an unclosed one silenced the rest of the file. Both are
// deleted: the shared declared-rules checker exempts per line, and a block marker is invisible to
// it, so a file could pass here and fail there for the same lines. Two exemption mechanisms for
// one meaning is a dialect. Per line also removes the unclosed-block failure mode entirely rather
// than guarding it, which is the better half of this trade.
const EXEMPT_MARKER = 'TENANT-NAME-EXEMPT';

function withoutCommentLines(source) {
  return source.split('\n')
    .filter((line) => {
      if (line.includes(EXEMPT_MARKER)) return false;
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

// Words long enough to be a name rather than a coincidence. Four is the floor because three-letter
// fragments collide with ordinary code ("web", "app", "the").
function identityWordsFrom(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

const SET_NAME_NOISE = new Set(['package', 'sets', 'deploy', 'main', 'live', 'test', 'demo']);

const sets = existsSync(PACKAGE_SETS_DIR)
  ? (await readdir(PACKAGE_SETS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];

if (sets.length === 0) {
  console.log(`FAIL: no package set under ${PACKAGE_SETS_DIR}, so this check has no tenant to`);
  console.log('derive forbidden words from and would pass while proving nothing.');
  process.exit(1);
}

// A TENANT OF THIS SERVER IS A SET THAT SHIPS A PAGE DESCRIPTION, and that predicate is the whole
// design. The first version derived words from every installed set folder, which was measured
// before being trusted and was garbage: 21 sets installed, most of them proof, staging and
// research sets whose folder names are ordinary words. It reported "find", "current", "items",
// "store", "source", "start" and "site" as tenant names in the server. A check that loud gets
// deleted or ignored, which is worse than no check, because its rule then reads as enforced.
const forbidden = new Map();
let tenantCount = 0;
for (const set of sets) {
  const descriptionFile = join(PACKAGE_SETS_DIR, set, 'deploy', 'page-description.json');
  if (!existsSync(descriptionFile)) continue;
  let described;
  try {
    described = JSON.parse(await readFile(descriptionFile, 'utf8'));
  } catch {
    continue;
  }
  tenantCount += 1;
  for (const word of identityWordsFrom(set)) {
    if (!SET_NAME_NOISE.has(word)) forbidden.set(word, `${set} (its folder name)`);
  }
  for (const page of Array.isArray(described?.pages) ? described.pages : []) {
    for (const word of [...identityWordsFrom(page?.brand), ...identityWordsFrom(page?.title)]) {
      if (!SET_NAME_NOISE.has(word)) forbidden.set(word, `${set} (its declared brand or title)`);
    }
    // THE NAMES A TENANT INVENTS ARE ALSO ITS OWN, not only the words in its brand. An envelope
    // key is declared by the tenant in `landing_offers` and referenced by its own bundle through
    // `island.state_envelopes`, so a generic source naming one has taken a tenant's vocabulary
    // into shared code. That is precisely the defect this package spent two passes removing: the
    // key set `patronPolicy`/`systemOffer` was written into FIVE places, and the fifth changed no
    // behaviour at all, so no assertion could ever have found it. Deriving these makes the whole
    // class unrepeatable rather than fixed once, and the words are whole tokens rather than
    // fragments, so they are checked exactly like a brand.
    for (const envelopeName of [
      ...Object.keys(page?.landing_offers ?? {}),
      ...Object.values(page?.island?.state_envelopes ?? {}),
    ]) {
      if (typeof envelopeName !== 'string' || envelopeName.length < 4) continue;
      forbidden.set(envelopeName.toLowerCase(), `${set} (an envelope name it declared)`);
    }
  }
}

console.log(`${forbidden.size} identity word(s) from ${tenantCount} tenant(s), of ${sets.length} installed set(s)\n`);
check('at least one installed set is a tenant of this server', tenantCount > 0,
  'no set ships deploy/page-description.json, so nothing here is being checked');
check('the installed sets yield identity words to check for', forbidden.size > 0,
  'nothing was derived, so this file would pass against any source at all');

const sources = await genericSources();
check('there are generic sources under processes/ to judge', sources.length > 0,
  `${PROCESSES_DIR} holds no non-test .mjs, so this file would pass having read nothing`);

for (const file of sources) {
  const name = file.split('/').pop();
  const raw = await readFile(file, 'utf8');
  // TOKENS, not substrings. A plain `includes` is wrong in a way that only shows up on someone
  // else's code: `setHostWidth` lowercases to `sethostwidth`, which CONTAINS `ethos`. Found by
  // running this idea across other packages, where it reported a React width hook as a tenant
  // name. A checker whose failures are absurd gets switched off, so the boundary is the check.
  const source = withoutCommentLines(raw).toLowerCase();
  const found = [...forbidden.entries()].filter(([word]) => {
    const boundary = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'u');
    return boundary.test(source);
  });
  check(`${name} names no installed tenant`, found.length === 0,
    found.map(([word, origin]) => `"${word}" from ${origin}`).join('; '));
}

console.log('');
if (failures > 0) {
  console.log(`FAIL: ${failures} check(s). A tenant's own words are in the shared binary, so every`);
  console.log('other tenant on this process would wear them. Move the value into that tenant\'s');
  console.log('page-description.json and read it from the description, as every other tenant');
  console.log('string in this server already is.');
  process.exit(1);
}
console.log('PASS: the generic sources name none of the installed tenants');
