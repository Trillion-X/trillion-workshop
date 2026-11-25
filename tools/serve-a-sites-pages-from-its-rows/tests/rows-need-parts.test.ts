// The check a pin or PAGES_COMMIT move runs first: every part and export the page rows name that a commit's tools lack, with
// the pages naming it, read as a page bundle reads it. A real tools folder (this checkout's) and made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { rowsNeedParts, SITE_PARTS } from '../do-work/rows-need-parts.ts';

const tools = join(import.meta.dirname, '..', '..');
const TEXT = 'ui/show/text/Text.tsx';
const row = (path: string, layout: unknown, tool: string | null = null) => ({ path, title: path, access: 'public', layout, tool, input: {}, collection: null, updated_at: null, host: null });
const ROWS = [
  row('/', { part: TEXT, export: 'Text', children: [{ part: TEXT, export: 'Section', children: [{ text: 'x' }] }, { tool: 'tool:not-a-tool-here', input: {} }] }),
  row('/about', [{ part: TEXT, export: 'Section' }, { part: 'ui/show/not-in-this-commit/NotHere.tsx' }, { tool: 'tool:anything', part: TEXT, export: 'Text' }]),
  row('/plain', { part: TEXT, export: 'Text', children: [{ text: 'fine' }] }),
];

test('every part, export and screen the rows name that the tools lack is listed once, with the pages naming it', async () => {
  const needed = await rowsNeedParts(ROWS, tools);
  assert.deepEqual(needed.missing, [
    { key: 'tool:not-a-tool-here', why: 'tool:not-a-tool-here has no module screen in these tools', pages: ['/'] },
    { key: 'ui/show/not-in-this-commit/NotHere.tsx#View', why: 'ui/show/not-in-this-commit/NotHere.tsx is not in the tools folder', pages: ['/about'] },
    { key: `${TEXT}#Section`, why: `${TEXT} has no export Section`, pages: ['/', '/about'] },
  ]);
  assert.equal(needed.named, 4 + SITE_PARTS.length - 1, 'Text#Text is both a row part and one of the site\'s own');
  assert.deepEqual(needed.rows_set_aside, []);
  assert.deepEqual((await rowsNeedParts([ROWS[2]], tools)).missing, [], 'rows the tools can draw need nothing');
});

test('run as a program it prints the list and exits 1 when anything is missing, 0 when nothing is', () => {
  const program = join(import.meta.dirname, '..', 'do-work', 'rows-need-parts.ts');
  const one = spawnSync(process.execPath, [program, '/dev/stdin', tools], { encoding: 'utf8', input: JSON.stringify({ rows: ROWS }) });
  assert.equal(one.status, 1, one.stderr);
  assert.equal(JSON.parse(one.stdout).missing.length, 3);
  assert.equal(spawnSync(process.execPath, [program, '/dev/stdin'], { encoding: 'utf8', input: JSON.stringify([ROWS[2]]) }).status, 0, 'a plain list of rows too');
});
