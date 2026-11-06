// Ported from old trillion test/kept-range-frontier-recovery.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. kept-runs is this tool's parts/record-log/do-work/kept-runs.mjs; the old
// in-memory module loader (test/import-source-for-tests.mjs) is a scratch-folder copy of the instrumented text. Every
// assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sqliteHost } from '../src/local-store.mjs';

test('a rejected successor preserves the real cursor frontier when a later seek widens its bounds', async () => {
  const source = readFileSync(new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url), 'utf8');
  // Expose the actual private cursor only in this test's module copy. Its owner,
  // search, bounds and next/peek/seek implementations are unchanged.
  const seam = '    held: () => ({ memtable_keys:';
  assert.equal(source.split(seam).length, 2, 'unique real owner return seam');
  const instrumented = source.replace(seam,
    '    testCursor: (lo, hi, reverse = false) => runCursor(runs[0], lo, hi, reverse),\n' + seam);
  // The instrumented copy is a module of its own in a scratch folder (old test/import-source-for-tests.mjs importSource),
  // its one relative import named by its full address.
  const own = new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url);
  const folder = mkdtempSync(join(tmpdir(), 'kept-range-frontier-'));
  const file = join(folder, 'kept-runs.mjs');
  writeFileSync(file, instrumented.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${new URL(relative, own).href}'`));
  const owner = await import(pathToFileURL(file).href).finally(() => rmSync(folder, { recursive: true, force: true }));
  const host = sqliteHost(':memory:');
  try {
    const options = { prefix: 'frontier', transaction: host.transaction, page_bytes: 128, cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
    let space = owner.keptRuns(host.sql, options);
    const keys = Array.from({ length: 16 }, (_, n) => 'k' + String(n).padStart(3, '0'));
    for (const [n, key] of keys.entries()) space.put(key, { n, text: 'x'.repeat(40) });
    space.flush(); space = owner.keptRuns(host.sql, options);
    const cursor = space.testCursor('k003\u0000', 'k004');
    assert.equal(cursor.peek(), null); assert.equal(cursor.peek(), null, 'repeated rejection holds no successor body');
    cursor.seek('k003\u0000', 'k006');
    assert.equal(cursor.peek()[0], 'k004', 'widening the upper bound does not skip the unloaded successor');
    cursor.next(); assert.equal(cursor.peek()[0], 'k005');
    cursor.next(); assert.equal(cursor.peek(), null);
    cursor.seek('k006', 'k008'); assert.equal(cursor.peek()[0], 'k006');
    cursor.seek('k002', 'k003'); assert.equal(cursor.peek()[0], 'k002', 'lowering bounds permits a fresh earlier seek');
    const reverse = space.testCursor('k003\u0000', 'k006', true);
    assert.equal(reverse.peek()[0], 'k005'); reverse.next(); assert.equal(reverse.peek()[0], 'k004');
    reverse.next(); assert.equal(reverse.peek(), null);
    reverse.seek('k001', 'k004'); assert.equal(reverse.peek()[0], 'k003');
  } finally { host.db.close(); }
});

