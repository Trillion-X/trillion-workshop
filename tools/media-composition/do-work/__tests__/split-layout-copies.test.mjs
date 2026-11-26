/**
 * file: tools/media-composition/do-work/__tests__/split-layout-copies.test.mjs
 *
 * buildSplitLayout lives twice: do-work/split-layout.mjs (the module the tests import) and a copy inlined at the end
 * of do-work/video-compose.mjs (the sandbox mounts only that script). The two copies (buildSplitLayout, normalizedWeights,
 * safeColor, drawtextFilter and their notes) must stay the same text; this fails the moment one is edited without the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = readFileSync(join(here, '..', 'split-layout.mjs'), 'utf8');
const INLINED = readFileSync(join(here, '..', 'video-compose.mjs'), 'utf8');

/** The text of a top-level function, from its first line to the `}` that starts a line. */
function functionText(source, opening) {
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `${opening} is not in the file`);
  assert.equal(source.indexOf(opening, start + 1), -1, `${opening} is in the file more than once`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

for (const opening of ['export function buildSplitLayout(', 'function normalizedWeights(', 'function safeColor(', 'function drawtextFilter(']) {
  test(`split-layout.mjs and video-compose.mjs hold the same ${opening.replace(/^export /, '').replace('(', '')}`, () => {
    assert.equal(functionText(INLINED, opening), functionText(MODULE, opening));
  });
}

test('split-layout.mjs is, word for word, the split-layout section inlined in video-compose.mjs', () => {
  const start = INLINED.indexOf('// packages/media-composition/do-work/split-layout.mjs\n');
  const end = INLINED.indexOf('// packages/media-composition/do-work/card-layout.mjs\n');
  assert.ok(start !== -1 && end > start, 'video-compose.mjs no longer marks its inlined split-layout section');
  assert.equal(INLINED.slice(start, end).trimEnd() + '\n', MODULE);
});
