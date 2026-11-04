// What stayed, by who wrote it: lines are credited to their first writer by BLAKE3 identity and counted only if the newest
// version still holds them; read back from a real record's change log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keptWork } from '../src/kept-work.mjs';
// Ported from Trillion-X/trillion test/kept-work.test.mjs: the cases over keptWork alone. The change-log and person-store cases
// stay with the old tree, where the ledger (makeKeptWork) runs inside the store's write.

test('a line is credited to whoever first wrote it, a rewritten line to the rewriter, and a removed line to nobody', () => {
  const kept = keptWork([
    { by: 'ai', text: 'Intro\nBody one\nBody two\n' },
    { by: 'person', text: 'Intro\nBody one rewritten\nBody two\nPerson line\n' },
    { by: 'ai', text: 'Intro\nBody one rewritten\nBody two\nPerson line\nAI addition' },
  ]);
  assert.deepEqual(kept, { by: { ai: 3, person: 2 }, kept: 5, versions: 3 });
  assert.deepEqual(keptWork([{ by: 'ai', text: 'x\ny' }, { by: 'person', text: '' }]).by, {});
  assert.deepEqual(keptWork([{ by: 'ai', text: '  Same   line ' }, { by: 'person', text: 'Same line' }]).by, { ai: 1 }, 'spacing alone is not a rewrite');
});
