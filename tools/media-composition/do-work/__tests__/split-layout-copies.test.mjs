/**
 * file: tools/media-composition/do-work/__tests__/split-layout-copies.test.mjs
 *
 * buildSplitLayout lives twice: do-work/split-layout.mjs (the module the tests import) and a copy inlined at the end
 * of do-work/video-compose.mjs (the sandbox mounts only that script). The two copies of buildSplitLayout and of
 * normalizedWeights must stay the same text; this fails the moment one is edited without the other.
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

for (const opening of ['export function buildSplitLayout(', 'function normalizedWeights(']) {
  test(`split-layout.mjs and video-compose.mjs hold the same ${opening.replace(/^export /, '').replace('(', '')}`, () => {
    assert.equal(functionText(INLINED, opening), functionText(MODULE, opening));
  });
}
