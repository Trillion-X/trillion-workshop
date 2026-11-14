import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const sourceFolders = ['show', 'read-data', 'do-work'];
const forbidden = new RegExp(
  ['A' + 'OM', 'Tri' + 'be', 'Eth' + 'os', 'Sup' + 'abase', '@sup' + 'abase', 'create' + 'Client'].join('|'),
  'i',
);

test('person-list entry points at the people directory screen', async () => {
  const data = JSON.parse(await readFile(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));
  const entry = data.things.find((thing) => thing.address === 'package::person-list::entry::person-list');
  const storedBytes = data.things.find((thing) => thing.type === 'stored_bytes' && thing.name === 'entry-bytes-person-list');

  assert.equal(data.package, 'person-list');
  assert.equal(entry.payload.kind, 'bitfield-package-entry');
  assert.equal(entry.payload.entry_name, 'person-list');
  assert.equal(entry.payload.source_path, 'show/mount-person-list.tsx');
  // An entry-bytes declaration has TWO live shapes and this package has migrated to the newer
  // one. The old shape carries `build.request.{source_file,source_kind}`; the new shape carries a
  // prebuilt `source_path` plus a `source_closure_receipt_path`. Both shapes are live, so this is a
  // partial migration and neither side can be assumed; the `??` below is what encodes that.
  //
  // This comment carried "Measured 2026-09-04: 38 boundaries still use the old shape" in both this
  // file and `item-record`. The count was doing rhetorical work the `??` already does structurally,
  // it was duplicated verbatim across two packages, and a comment stating a measurement cannot be
  // corrected by the change that invalidates it. Counts belong in a knowledge leaf with their
  // method and date; code carries the invariant, which needs no number.
  //
  // Asserting only the old shape is why this test went red: the DATA moved and the assertion did
  // not. It is written to accept either, the same way
  // `content-production/__tests__/capability-delivery.test.mjs` already does
  // (`entry.source_path ?? entry.build?.request?.source_file`), rather than inventing a second
  // accommodation for one migration.
  const declaredSource = storedBytes.source_path ?? storedBytes.build?.request?.source_file;
  if (storedBytes.build) {
    assert.equal(declaredSource, 'show/mount-person-list.tsx');
    assert.equal(storedBytes.build.request.source_kind, 'text/typescript-jsx');
  } else {
    assert.equal(declaredSource, 'built-stored-bytes/entry-bytes-person-list');
    assert.equal(storedBytes.source_closure_receipt_path, 'built-stored-bytes/entry-bytes-person-list.source-closure.json');
  }
  await readFile(new URL('../show/mount-person-list.tsx', import.meta.url), 'utf8');
});

test('person-list source stays free of outside product and provider names', async () => {
  for (const folder of sourceFolders) {
    const folderUrl = new URL(`../${folder}/`, import.meta.url);
    for (const fileName of await readdir(folderUrl)) {
      if (!/\.(ts|tsx|js|jsx)$/.test(fileName)) continue;
      const source = await readFile(new URL(fileName, folderUrl), 'utf8');
      assert.doesNotMatch(source, forbidden, `${folder}/${fileName}`);
    }
  }
});
