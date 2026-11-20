// A bundle's real import graph is judged against each package's declared public files. Packages here are made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundlePackageBoundaries, checkDeclaration, describeFinding, publicPathsOf } from '../do-work/check-bundle-package-boundaries.mjs';

const declaration = { file: 'public-files.json', entries_at: 'things', kind_at: 'payload.kind', kind: 'public-source', path_at: 'payload.source_path' };

async function workspace() {
  const root = tempFolder(join(tmpdir(), 'bundle-boundaries-'));
  const packagesRoot = join(root, 'packages');
  const declare = async (name, publicPaths) => {
    await mkdir(join(packagesRoot, name), { recursive: true });
    const things = publicPaths.map(source_path => ({ payload: { kind: 'public-source', source_path } }));
    await writeFile(join(packagesRoot, name, declaration.file), JSON.stringify({ things }));
  };
  await declare('shapes', ['show']);
  await declare('ledger', ['do-work/read-total.mjs']);
  await mkdir(join(packagesRoot, 'broken'), { recursive: true });
  await writeFile(join(packagesRoot, 'broken', declaration.file), '{ not json');
  return { bundleRoot: join(root, 'host'), packagesRoot, declaration };
}

const edge = path => ({ path });

test('the shared pure projection supports string entries and a root list without adding an implicit declaration path', () => {
  const schema = { file: 'exports.json', entries_at: 'public', path_at: '' };
  const parsed = { public: ['show/a.mjs', './show//a.mjs', 'read-data'] };
  const before = structuredClone(parsed);
  assert.deepEqual(publicPathsOf(parsed, schema), ['show/a.mjs', 'read-data']);
  assert.deepEqual(parsed, before);
  assert.deepEqual(publicPathsOf(parsed.public, { ...schema, entries_at: '' }), ['show/a.mjs', 'read-data']);
  assert.deepEqual(publicPathsOf({ public: [] }, schema), []);
  for (const bad of [{}, { public: null }, { public: {} }, { public: 'show' }]) assert.throws(() => publicPathsOf(bad, schema), /has no list/);
});

test('invalid entries never create public roots, including traversal, foreign absolute paths and non-text values', () => {
  const schema = { file: 'exports.json', entries_at: 'public', path_at: '' };
  assert.deepEqual(publicPathsOf({ public: ['../outside', 'show/../outside', '/absolute', '//host/share', 'C:/outside', 'C:\\outside', 'show\\outside', 'show\u0000x', 'show\nx', '.', '', null, {}, 1, ['show']] }, schema), []);
  const inherited = Object.create({ public: ['show'] });
  assert.throws(() => publicPathsOf(inherited, schema), /has no list/);
  const inheritedEntry = Object.create({ payload: { kind: 'public-source', source_path: 'show' } });
  assert.deepEqual(publicPathsOf({ things: [inheritedEntry] }, declaration), []);
});

test('the object API keeps kind filtering; unfiltered object entries use the same path lens', () => {
  const things = [{ payload: { kind: 'public-source', source_path: './show' } }, { payload: { kind: 'note', source_path: 'private' } }, { payload: { kind: 'public-source', source_path: '../outside' } }];
  assert.deepEqual(publicPathsOf({ things }, declaration), ['show']);
  assert.deepEqual(publicPathsOf({ things }, { file: declaration.file, entries_at: 'things', path_at: 'payload.source_path' }), ['show', 'private']);
  for (const malformed of [{ kind_at: 'payload.kind' }, { kind: 'public-source' }, { kind_at: null, kind: 'public-source' }]) assert.throws(() => checkDeclaration({ file: declaration.file, entries_at: 'things', path_at: '', ...malformed }), /supplied together/);
  for (const field of ['entries_at', 'path_at', 'kind_at']) assert.throws(() => checkDeclaration({ ...declaration, [field]: 'payload..path' }), /dotted path/);
});

test('the bundle checker delegates string declarations to the same projection and keeps private neighbors private', async () => {
  const where = await workspace();
  const schema = { file: declaration.file, entries_at: 'public', path_at: '' };
  await writeFile(join(where.packagesRoot, 'shapes', schema.file), JSON.stringify({ public: ['show/circle.mjs'] }));
  const metafile = { inputs: { 'src/app.mjs': { imports: [edge('../packages/shapes/show/circle.mjs'), edge('../packages/shapes/show/private.mjs')] } } };
  const report = checkBundlePackageBoundaries({ metafile, ...where, declaration: schema });
  assert.deepEqual(report.findings.map(finding => [finding.rule, finding.target_path]), [['package-private-source-reached', 'show/private.mjs']]);
  await writeFile(join(where.packagesRoot, 'shapes', schema.file), JSON.stringify({ public: 'show' }));
  assert.ok(checkBundlePackageBoundaries({ metafile, ...where, declaration: schema }).findings.every(finding => finding.rule === 'package-boundary-unreadable'));
});

test('public files, the declaration file, same-package edges and unowned files pass', async () => {
  const where = await workspace();
  const metafile = { inputs: {
    'src/app.mjs': { imports: [edge('../packages/shapes/show/circle.mjs'), edge('../packages/ledger/do-work/read-total.mjs'), edge('../packages/ledger/public-files.json'), edge('../vendor/lib.mjs'), { path: 'node:fs', external: true }] },
    '../packages/ledger/do-work/read-total.mjs': { imports: [edge('../packages/ledger/do-work/private-sum.mjs')] },
    'virtual:stub': { imports: [] },
  } };
  const report = checkBundlePackageBoundaries({ metafile, ...where });
  assert.deepEqual(report.findings, []);
  assert.equal(report.edges_checked, 3);
  assert.deepEqual(report.packages_reached, ['ledger', 'shapes']);
});

test('a host or another package reaching a private file is a finding, said in words', async () => {
  const where = await workspace();
  const metafile = { inputs: {
    'src/app.mjs': { imports: [edge('../packages/ledger/do-work/private-sum.mjs')] },
    '../packages/shapes/show/circle.mjs': { imports: [edge('../packages/ledger/do-work/read-totally-private.mjs')] },
  } };
  const report = checkBundlePackageBoundaries({ metafile, ...where });
  assert.deepEqual(report.findings.map(f => [f.rule, f.importer, f.package, f.target_path]), [
    ['package-private-source-reached', 'src/app.mjs', 'ledger', 'do-work/private-sum.mjs'],
    ['package-private-source-reached', '../packages/shapes/show/circle.mjs', 'ledger', 'do-work/read-totally-private.mjs'],
  ]);
  assert.match(describeFinding(report.findings[0], declaration), /ledger\/do-work\/private-sum\.mjs, which ledger has not declared public.*ledger\/public-files\.json/);
});

test('a namespaced absolute path is judged as the file it names; an unreadable declaration never passes', async () => {
  const where = await workspace();
  const metafile = { inputs: { 'src/app.mjs': { imports: [edge(`plugin:${join(where.packagesRoot, 'shapes', 'read-data', 'x.mjs')}`), edge('../packages/broken/show/y.mjs')] } } };
  const report = checkBundlePackageBoundaries({ metafile, ...where });
  assert.deepEqual(report.findings.map(f => [f.rule, f.package, f.target_path]), [
    ['package-private-source-reached', 'shapes', 'read-data/x.mjs'],
    ['package-boundary-unreadable', 'broken', 'show/y.mjs'],
  ]);
  assert.match(describeFinding(report.findings[1], declaration), /broken, whose public-files\.json cannot be read/);
});

test('a declaration is required whole; the checker holds no default for it, and entries of another kind or outside the package declare nothing', async () => {
  const where = await workspace();
  assert.throws(() => checkBundlePackageBoundaries({ metafile: { inputs: {} }, ...where, declaration: { file: 'public-files.json' } }), /declaration\.entries_at is required/);
  assert.throws(() => checkBundlePackageBoundaries({ metafile: { inputs: {} }, ...where, declaration: { ...declaration, file: '../x.json' } }), /not a path/);
  await writeFile(join(where.packagesRoot, 'shapes', declaration.file), JSON.stringify({ things: [
    { payload: { kind: 'note', source_path: 'show' } },
    { payload: { kind: 'public-source', source_path: '../elsewhere' } },
    { payload: { kind: 'public-source', source_path: '/abs' } },
  ] }));
  const report = checkBundlePackageBoundaries({ metafile: { inputs: { 'src/app.mjs': { imports: [edge('../packages/shapes/show/circle.mjs')] } } }, ...where });
  assert.equal(report.findings.length, 1);
  const missingList = checkBundlePackageBoundaries({ metafile: { inputs: { 'src/app.mjs': { imports: [edge('../packages/shapes/show/circle.mjs')] } } }, ...where, declaration: { ...declaration, entries_at: 'absent.list' } });
  assert.equal(missingList.findings[0].rule, 'package-boundary-unreadable');
});
