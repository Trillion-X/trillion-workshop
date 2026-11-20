// A bundle's real import graph is judged against each part's declared public files (scripts/check-bundle-part-boundaries.mjs).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkBundlePartBoundaries } from '../scripts/check-bundle-part-boundaries.mjs';

const scratch = fileURLToPath(new URL('../.state/', import.meta.url));

async function workspace() {
  await mkdir(scratch, { recursive: true });
  const root = tempFolder(join(scratch, 'bundle-boundaries-'));
  const partsRoot = join(root, 'parts');
  const declare = async (name, publicPaths) => {
    await mkdir(join(partsRoot, name), { recursive: true });
    await writeFile(join(partsRoot, name, 'part.json'), JSON.stringify({ public: publicPaths }));
  };
  await declare('shapes', ['show']);
  await declare('ledger', ['do-work/read-total.mjs']);
  await mkdir(join(partsRoot, 'broken'), { recursive: true });
  await writeFile(join(partsRoot, 'broken', 'part.json'), '{ not json');
  return { bundleRoot: join(root, 'host'), partsRoot };
}

const edge = path => ({ path });

test('public files, part.json, same-part edges and unowned files pass', async () => {
  const { bundleRoot, partsRoot } = await workspace();
  const metafile = { inputs: {
    'src/app.mjs': { imports: [edge('../parts/shapes/show/circle.mjs'), edge('../parts/ledger/do-work/read-total.mjs'), edge("../parts/ledger/part.json with { type: 'json' }"), edge('../vendor/lib.mjs'), { path: 'node:fs', external: true }] },
    '../parts/ledger/do-work/read-total.mjs': { imports: [edge('../parts/ledger/do-work/private-sum.mjs')] },
    'virtual:stub': { imports: [] },
  } };
  const report = checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot });
  assert.deepEqual(report.findings, []);
  assert.equal(report.edges_checked, 3);
  assert.deepEqual(report.parts_reached, ['ledger', 'shapes']);
});

test('import attributes do not make a declared JSON file appear private', async () => {
  const { bundleRoot, partsRoot } = await workspace();
  const metafile = { inputs: {
    'src/app.mjs': { imports: [edge("../parts/shapes/show/appearance.json with { type: 'json' }")] },
  } };
  const report = checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot });
  assert.deepEqual(report.findings, []);
  assert.equal(report.edges_checked, 1);
});

test('a host or another part reaching a private file is a finding', async () => {
  const { bundleRoot, partsRoot } = await workspace();
  const metafile = { inputs: {
    'src/app.mjs': { imports: [edge('../parts/ledger/do-work/private-sum.mjs')] },
    '../parts/shapes/show/circle.mjs': { imports: [edge('../parts/ledger/do-work/read-totally-private.mjs')] },
  } };
  const report = checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot });
  assert.deepEqual(report.findings.map(f => [f.rule, f.importer, f.part, f.target_path]), [
    ['part-private-source-reached', 'src/app.mjs', 'ledger', 'do-work/private-sum.mjs'],
    ['part-private-source-reached', '../parts/shapes/show/circle.mjs', 'ledger', 'do-work/read-totally-private.mjs'],
  ]);
});

test('a namespaced absolute path is judged as the file it names; an unreadable part.json never passes', async () => {
  const { bundleRoot, partsRoot } = await workspace();
  const metafile = { inputs: { 'src/app.mjs': { imports: [edge(`trimmed:${join(partsRoot, 'shapes', 'read-data', 'x.mjs')}`), edge('../parts/broken/show/y.mjs')] } } };
  const report = checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot });
  assert.deepEqual(report.findings.map(f => [f.rule, f.part, f.target_path]), [
    ['part-private-source-reached', 'shapes', 'read-data/x.mjs'],
    ['part-boundary-unreadable', 'broken', 'show/y.mjs'],
  ]);
});

test('JSON import attributes identify the same declared public file', async () => {
  const { bundleRoot, partsRoot } = await workspace();
  const metafile = { inputs: { 'src/app.mjs': { imports: [edge("../parts/ledger/do-work/read-total.mjs with { type: 'json' }")] } } };
  assert.deepEqual(checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot }).findings, []);
});
