// Names that failed the finger-point test (trillion-rust docs/names.md, docs/naming-decision.md) may not be used
// more often than they are today. The list is DATA (test/failed-names.json): each name, the word to use instead, its
// forms as word parts, and the most uses allowed. A use is the form's word parts in a row, in any identifier
// (`place_key`, `PlaceKey`, `PLACE_KEY`, `place-key` are all "place" then "key") or in text, in this repository's code
// and in every screen-words file (`*words*.json`). Byte copies kept from old trillion (`from-old-trillion` folders,
// `*.held` files), installed packages, and a file moved here whose bytes are still exactly what its moved-from.json
// receipt records (`to` and `identity`) are not counted: they are originals, not code written here, and a rename inside one
// would break the receipt that proves it. Once such a file is edited its identity no longer matches and it counts. The numbers only go down: a change that removes uses lowers
// its number in the same commit. Mirrors trillion-rust tests/failed_names.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../tools/content-identity/read-data/identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIST = JSON.parse(readFileSync(join(ROOT, 'test/failed-names.json'), 'utf8'));
const SELF = 'test/failed-names.test.mjs';
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|py|sh|swift|rs|kt|java|m|h|c|go|rb|css|html|svelte|vue)$/;
const SKIP = new Set(['node_modules', '.git', 'from-old-trillion', 'target', 'dist', 'build', '.build', 'DerivedData']);

// Every receipt's moved file and the identity it was moved with: { 'tools/<tool>/...': '1f:...' }.
function movedCopies(dir = join(ROOT, 'tools')) {
  const moved = new Map();
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (typeof value.to === 'string' && typeof value.identity === 'string') moved.set(value.to, value.identity);
    Object.values(value).forEach(walk);
  };
  for (const tool of readdirSync(dir, { withFileTypes: true })) {
    if (!tool.isDirectory()) continue;
    try { walk(JSON.parse(readFileSync(join(dir, tool.name, 'moved-from.json'), 'utf8'))); } catch {}
  }
  return moved;
}

/** Whether the file is a moved original still byte for byte as its receipt records it. */
export const isMovedOriginal = (path, bytes, moved) => moved.get(path) === makeHashCodeHexFromBytes(bytes);

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else if (entry.isFile() && counted(relative(ROOT, path))) out.push(path);
  }
  return out;
}

const counted = path => path !== SELF && !path.endsWith('.held')
  && (CODE.test(path) || (/words[^/]*\.json$/.test(path.split('/').pop())));

/** The text's word parts, lowercase, in order: identifiers split at `_`, `-` and at each capital that starts a part. */
export function parts(text) {
  const out = [];
  for (const token of text.split(/[^A-Za-z0-9_]/)) {
    for (const piece of token.split('_')) {
      let start = 0;
      for (let i = 1; i < piece.length; i++) {
        const upperAfterLower = /[A-Z]/.test(piece[i]) && !/[A-Z]/.test(piece[i - 1]);
        const acronymEnd = /[a-z]/.test(piece[i]) && /[A-Z]/.test(piece[i - 1]) && i - 1 > start;
        if (upperAfterLower || acronymEnd) {
          const end = acronymEnd ? i - 1 : i;
          out.push(piece.slice(start, end).toLowerCase());
          start = end;
        }
      }
      if (start < piece.length) out.push(piece.slice(start).toLowerCase());
    }
  }
  return out;
}

const uses = (words, form) => {
  let n = 0;
  for (let i = 0; i + form.length <= words.length; i++) if (form.every((part, j) => words[i + j] === part)) n++;
  return n;
};

test('no failed name is used more than its recorded count', () => {
  const moved = movedCopies();
  const texts = files(ROOT).flatMap(path => {
    const bytes = readFileSync(path);
    return isMovedOriginal(relative(ROOT, path), bytes, moved) ? [] : [parts(bytes.toString('utf8'))];
  });
  const grown = [];
  for (const name of LIST.names) {
    const found = texts.reduce((sum, words) => sum + name.forms.reduce((n, form) => n + uses(words, form), 0), 0);
    if (found > name.most) grown.push(`${name.name}: ${found} uses, at most ${name.most} (use ${name.use_instead} instead; trillion-rust docs/names.md)`);
  }
  assert.deepEqual(grown, [], `a failed name gained uses:\n${grown.join('\n')}`);
});

test('word parts split identifiers and text alike', () => {
  assert.deepEqual(parts('place_key PlaceKey PLACE_KEY place-key the place key'),
    ['place', 'key', 'place', 'key', 'place', 'key', 'place', 'key', 'the', 'place', 'key']);
  assert.deepEqual(parts('S2hStore'), ['s2h', 'store']);
  assert.equal(uses(parts('marketplace placement places'), ['place']), 0);
});

test('a moved original counts only once its bytes differ from its receipt', () => {
  const bytes = Buffer.from('const place = 1;\n');
  const moved = new Map([['tools/example/do-work/moved.mjs', makeHashCodeHexFromBytes(bytes)]]);
  assert.equal(isMovedOriginal('tools/example/do-work/moved.mjs', bytes, moved), true);
  assert.equal(isMovedOriginal('tools/example/do-work/moved.mjs', Buffer.from('const place = 2;\n'), moved), false, 'an edited copy counts');
  assert.equal(isMovedOriginal('tools/example/do-work/other.mjs', bytes, moved), false, 'a file no receipt names counts');
});
