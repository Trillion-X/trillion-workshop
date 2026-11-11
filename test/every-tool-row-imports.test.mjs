// Every tool row packs the files its entry program reaches through relative imports (test-helpers/tool-row-imports.mjs).
// A gap is a file the engine would start without: ERR_MODULE_NOT_FOUND on the installed snapshot. Read from HEAD, so the
// check judges the tree under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { toolRowFindings } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');

test('every tool row packs every file its entry program reaches through a relative import, and names its entry program', () => {
  const { results } = toolRowFindings({ repo, ref: 'HEAD' });
  const gaps = results.flatMap(row => (row.findings || [])
    .filter(f => f.kind === 'missing-relative-import' || f.kind === 'argv-not-declared')
    .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.spec ?? f.target ?? ''} ${f.needs ?? ''}`.trim()));
  assert.deepEqual(gaps, [], `\n${gaps.join('\n')}\n\nAdd each file to the row's invoke.files.package_files (its package's paths, at /opt/<package>).`);
});
