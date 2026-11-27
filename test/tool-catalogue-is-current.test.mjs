// README.md's tool catalogue is the one generated from every folder's what-this-tool-does-and-how-to-run-it.json. It fails when a row was added, changed
// or removed without running `node test-helpers/write-tool-catalogue.mjs`, and when a tool id is listed twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueEntries, catalogueBlock, readReadme, spliceCatalogue } from '../test-helpers/tool-catalogue.mjs';

test('README.md holds exactly the catalogue the tool rows generate', () => {
  const readme = readReadme();
  assert.equal(spliceCatalogue(readme, catalogueBlock()), readme,
    'README.md tool catalogue is stale: run node test-helpers/write-tool-catalogue.mjs');
});

test('the catalogue lists each folder once and each tool id once', () => {
  const entries = catalogueEntries();
  assert.equal(new Set(entries.map(({ folder }) => folder)).size, entries.length);
  const ids = entries.flatMap(({ ids }) => ids);
  assert.equal(new Set(ids).size, ids.length, 'a tool id is offered by more than one row');
  assert.ok(ids.length > 0, 'the rows offer at least one tool');
});

test('a README without the catalogue markers is refused, not silently left stale', () => {
  assert.throws(() => spliceCatalogue('# no markers here\n', catalogueBlock()), /exactly one/);
});
