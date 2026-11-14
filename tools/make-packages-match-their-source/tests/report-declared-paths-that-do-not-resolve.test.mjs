import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  declaredPathCountsByKey,
  valuesAtKeys,
  unresolvedPathsInDocument,
  unresolvedPathsAcrossDocuments,
} from '../do-work/report-declared-paths-that-do-not-resolve.mjs';

const nothingExists = () => false;
const everythingExists = () => true;

test('a named key nested under arrays and objects alike is found', () => {
  const document = { things: [{ payload: { from: 'a/one' } }, { payload: [{ from: 'b/two' }] }] };
  const found = [...valuesAtKeys(document, ['from'])].map((f) => f.value);
  assert.deepEqual(found, ['a/one', 'b/two']);
});

test('the route says where the declaration was, as steps rather than a joined string', () => {
  const document = { things: [{ payload: { from: 'a/one' } }] };
  const [found] = [...valuesAtKeys(document, ['from'])];
  assert.deepEqual(found.route, ['things', 0, 'payload', 'from']);
});

// The array-payload case is the one a shallow object-only walker reports as clean, and five real
// documents in this corpus have exactly that shape.
test('a payload that is an array is walked, not skipped', () => {
  const document = { things: [{ payload: [{ deep: [{ from: 'buried' }] }] }] };
  assert.equal([...valuesAtKeys(document, ['from'])].length, 1);
});

test('a resolving path is not a finding and a dead one is', () => {
  const document = { from: 'somewhere' };
  assert.deepEqual(unresolvedPathsInDocument({ document, keys: ['from'], bases: ['/base'], exists: everythingExists }), []);
  const [found] = unresolvedPathsInDocument({ document, keys: ['from'], bases: ['/base'], exists: nothingExists });
  assert.equal(found.declared, 'somewhere');
  assert.deepEqual(found.tried, ['/base/somewhere']);
});

// THE TWO SHAPES THAT MADE THE FIRST RUN 100% FALSE FINDINGS. Both are real: measured across 306
// documents, where resolving against one base with exact spelling reported 39 dead paths and every
// one of them was alive. These are the regression tests for that, not hypotheticals.
test('a value rooted at an enclosing folder rather than the document folder resolves', () => {
  const found = unresolvedPathsInDocument({
    document: { from: 'packages/thing/show/Panel.tsx' },
    keys: ['from'],
    bases: ['/set/packages/thing', '/set'],
    exists: (p) => p === '/set/packages/thing/show/Panel.tsx',
  });
  assert.deepEqual(found, []);
});

test('a value whose suffix the reader appends resolves', () => {
  const found = unresolvedPathsInDocument({
    document: { from: 'read-data/read-sessions' },
    keys: ['from'],
    bases: ['/pkg'],
    suffixes: ['', '.ts'],
    exists: (p) => p === '/pkg/read-data/read-sessions.ts',
  });
  assert.deepEqual(found, []);
});

test('a dead value reports every candidate that was tried, so the report is diagnosable', () => {
  const [found] = unresolvedPathsInDocument({
    document: { from: 'gone' },
    keys: ['from'],
    bases: ['/a', '/b'],
    suffixes: ['', '.ts'],
    exists: nothingExists,
  });
  assert.deepEqual(found.tried, ['/a/gone', '/a/gone.ts', '/b/gone', '/b/gone.ts']);
});

// Re-rooting an absolute declaration under a base reports a working path as dead.
test('an absolute declaration keeps its own root', () => {
  const seen = [];
  unresolvedPathsInDocument({
    document: { from: '/elsewhere/thing' },
    keys: ['from'],
    bases: ['/base'],
    exists: (p) => { seen.push(p); return false; },
  });
  assert.deepEqual(seen, ['/elsewhere/thing']);
});

// Each of these would make the report silently clean, or silently report everything, forever.
test('naming no keys is refused rather than reporting nothing', () => {
  assert.throws(() => unresolvedPathsInDocument({ document: {}, keys: [], bases: ['/base'] }), /NO_KEYS_NAMED/);
});

test('naming no base is refused rather than resolving against the working directory', () => {
  assert.throws(() => unresolvedPathsInDocument({ document: {}, keys: ['from'], bases: [] }), /NO_BASES_NAMED/);
});

test('an empty suffix list is refused, because it can resolve nothing', () => {
  assert.throws(
    () => unresolvedPathsInDocument({ document: {}, keys: ['from'], bases: ['/base'], suffixes: [] }),
    /NO_SUFFIXES_NAMED/,
  );
});

// Named "non-string" until 2026-09-09, which stopped being true the moment a LIST of strings
// became a list of declarations. An object at a named key is still a different shape and still not
// an error; that is the case this actually covers and now the case it claims.
test('a named key holding an object is not a declaration and not an error', () => {
  const document = { from: { nested: 'shape' } };
  assert.deepEqual(unresolvedPathsInDocument({ document, keys: ['from'], bases: ['/base'], exists: nothingExists }), []);
});

// THE SHAPE THIS REPORT COULD NOT SEE FOR ITS WHOLE LIFE, and the corpus is mostly this shape.
// Every declared test path lives in a `checks` ARRAY, so each string fell out at the top of the
// walker for not being an object and the report answered "nothing is wrong" about 420 paths it had
// never opened. Nothing errored, which is the point: it read exactly like a clean corpus.
test('a key named as holding many addresses yields each entry', () => {
  const document = { payload: { checks: ['tests/one.mjs', 'tests/two.mjs'] } };
  const found = [...valuesAtKeys(document, [], [], ['checks'])].map((f) => f.value);
  assert.deepEqual(found, ['tests/one.mjs', 'tests/two.mjs']);
});

test('a dead entry in a list says WHICH one, by index in its route', () => {
  const [found] = unresolvedPathsInDocument({
    document: { checks: ['alive', 'dead'] },
    eachInKeys: ['checks'],
    bases: ['/base'],
    exists: (p) => p === '/base/alive',
  });
  assert.equal(found.declared, 'dead');
  assert.deepEqual(found.route, ['checks', 1]);
});

test('a list of objects at such a key is still walked for nested declarations', () => {
  const document = { checks: [{ from: 'buried' }] };
  assert.deepEqual(
    [...valuesAtKeys(document, ['from'], [], ['checks'])].map((f) => f.value),
    ['buried'],
  );
});

// THE FALSE-FINDINGS REGRESSION, and it is why this is two arguments rather than "a list at a
// named key is a list of declarations". A list of strings has TWO meanings in this corpus and its
// SHAPE does not say which: `checks` is many file addresses, while an interpreter projection's
// `source_path` is ONE record address written as segments. Treating every list as many addresses
// reported 10 dead paths and all 10 were those segments. A report whose findings are all false
// gets deleted along with the real finding it would have caught later.
test('a key holding one address written as segments is not many addresses', () => {
  const document = { source_path: ['current-item', 'published-record'] };
  assert.deepEqual([...valuesAtKeys(document, ['source_path'])], []);
  assert.deepEqual(
    unresolvedPathsInDocument({ document, keys: ['source_path'], bases: ['/base'], exists: nothingExists }),
    [],
  );
});

// THE DENOMINATOR. Without it a wrong key and a clean corpus print the same thing, which is how
// the list-of-strings defect above survived: asking for `check_files` when the field is `checks`
// gave output byte-identical to a genuinely clean package, and so did asking for `checks` while the
// walker could not see lists. A failure count alone cannot say whether the question was asked.
test('the count of declarations found is reported per key, so a wrong key is not a clean answer', () => {
  const documents = [{ source: 'one', document: { checks: ['a', 'b'], from: 'c' }, bases: ['/base'] }];
  assert.deepEqual(declaredPathCountsByKey(documents, ['from'], ['checks']), { from: 1, checks: 2 });
  assert.deepEqual(declaredPathCountsByKey(documents, ['check_files']), { check_files: 0 });
});

// The key travels BESIDE the route rather than at the end of it. Once a list entry appends an
// index, the last step of a route is a number, so anything grouping by "the last thing in the
// route" starts counting under `0` and `1` and reports every key as empty.
test('a declaration carries which key it came from, even from inside a list', () => {
  const [fromList] = [...valuesAtKeys({ checks: ['a'] }, [], [], ['checks'])];
  assert.equal(fromList.key, 'checks');
  assert.deepEqual(fromList.route, ['checks', 0]);
  const [plain] = [...valuesAtKeys({ from: 'a' }, ['from'])];
  assert.equal(plain.key, 'from');
});

test('each document resolves against its own bases', () => {
  const found = unresolvedPathsAcrossDocuments([
    { source: 'one', document: { from: 'x' }, bases: ['/a'] },
    { source: 'two', document: { from: 'x' }, bases: ['/b'] },
  ], ['from'], [''], nothingExists);
  assert.deepEqual(found.map((f) => f.tried[0]), ['/a/x', '/b/x']);
  assert.deepEqual(found.map((f) => f.source), ['one', 'two']);
});
