import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../show/DesktopSidebar.tsx', import.meta.url), 'utf8');
const words = JSON.parse(readFileSync(new URL('./sidebar-words.json', import.meta.url), 'utf8'));

test('the sidebar resize name is a line of the words file, not written in the component', () => {
  assert.equal(words.resize, 'Resize {thing}');
  assert.ok(!source.includes('`Resize ${thing}`'));
});

test('the docked resize handle draws its rail at rest', () => {
  assert.ok(!source.includes('revealed={false}'));
});
