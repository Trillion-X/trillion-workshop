// Icon and NamedIcon take `size` as a token (xs, sm, md, lg, xl: ui/show/icon/Icon.tsx iconVariants), never a number. A number
// matches no variant, so the svg gets no size class and Lucide draws its own 24 px: the Settings rail's icons were oversized
// that way (reported 1:38 PM CST Nov 25 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = fileURLToPath(new URL('../..', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.local', '.git']);
const OPENING_TAG = /<(?:Named)?Icon\b[^<>]*?\bsize=\{\s*[\d.]+\s*\}/g;

function* sources(folder) {
  for (const name of readdirSync(folder)) {
    if (SKIP.has(name)) continue;
    const path = join(folder, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* sources(path);
    else if (name.endsWith('.tsx')) yield path;
  }
}

test('no Icon or NamedIcon is given a numeric size', () => {
  const found = [];
  for (const path of sources(tools)) {
    const text = readFileSync(path, 'utf8');
    for (const hit of text.matchAll(OPENING_TAG)) found.push(`${path.slice(tools.length)}:${text.slice(0, hit.index).split('\n').length}`);
  }
  assert.deepEqual(found, []);
});

test('the check sees a numeric size on one line and across lines', () => {
  assert.equal('<NamedIcon name="X" size={16} />'.match(OPENING_TAG)?.length, 1);
  assert.equal('<Icon\n  icon={X}\n  size={14}\n/>'.match(OPENING_TAG)?.length, 1);
  assert.equal('<NamedIcon name="X" size="md" />'.match(OPENING_TAG), null);
});
