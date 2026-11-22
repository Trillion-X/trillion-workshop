// A wake a recipe or kit file declares carries only the keys the engine's wake Declaration accepts. The engine refuses the
// whole wake for any other key ("wake-not-offered reason=unknown_setting"): workflow:watch-the-law-for-each-niche's
// weekly wake was refused on the Mac from the day its file held a saved wake:list line (mark, switched_on, tool).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;

// The one place the allowed keys are written: struct Declaration in trillion-rust src/wake.rs (deny_unknown_fields).
const DECLARATION_KEYS = new Set(['id', 'on', 'budget', 'input', 'until', 'retry', 'skip_unchanged', 'rate', 'replay', 'needs_input', 'on_failure']);

// Recipe files and kit files; a kit's worked_examples show a wake:list answer to a tool, which is not a declaration.
const declaringFiles = readdirSync(join(root, 'tools'), { recursive: true })
  .filter(path => path.endsWith('.json') && !path.includes('node_modules'))
  .filter(path => path.split(sep).some(part => part === 'kits' || part === 'recipes'));

const wakesOf = (value, path = '') => {
  if (Array.isArray(value)) return value.flatMap((item, at) => wakesOf(item, `${path}/${at}`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    if (key === 'worked_examples') return [];
    const here = `${path}/${key}`;
    if (key === 'wakes' && Array.isArray(inner)) return inner.map((wake, at) => ({ at: `${here}/${at}`, wake }));
    return wakesOf(inner, here);
  });
};

test('every wake a recipe or kit file declares uses only Declaration keys', () => {
  assert.ok(declaringFiles.length > 100, 'the recipe and kit files are found');
  const outside = declaringFiles.flatMap(file => wakesOf(JSON.parse(readFileSync(join(root, 'tools', file), 'utf8')))
    .map(({ at, wake }) => ({ file: `tools/${file}`, at, id: wake.id, extra: Object.keys(wake).filter(key => !DECLARATION_KEYS.has(key)) }))
    .filter(({ extra }) => extra.length));
  assert.deepEqual(outside, []);
});

test('a wake with a saved wake:list line is caught', () => {
  const [{ wake }] = wakesOf({ records: [{ payload: { wakes: [{ id: 'weekly', on: {}, budget: {}, switched_on: false, mark: {}, tool: 'x' }] } }] });
  assert.deepEqual(Object.keys(wake).filter(key => !DECLARATION_KEYS.has(key)), ['switched_on', 'mark', 'tool']);
});
