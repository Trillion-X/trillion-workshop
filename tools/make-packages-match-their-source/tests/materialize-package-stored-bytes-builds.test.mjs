import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { materializePackageStoredBytesBuilds } from '../do-work/materialize-package-stored-bytes-builds.mjs';

const root = tempFolder(path.join(tmpdir(), 'materialize-stored-bytes-test.'));
try {
  const packageRoot = path.join(root, 'packages', 'example');
  await mkdir(path.join(packageRoot, 'source'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(packageRoot, 'source', 'input.js'), 'export const answer = 42;\n');
  await writeFile(
    path.join(root, 'scripts', 'shared-builder.mjs'),
    "import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(process.env.BITFIELD_PACKAGE_BUILD_REQUEST,'utf8'));if(Object.hasOwn(r,'package_root'))throw new Error('host path leaked');if(process.env.SHOULD_NOT_LEAK)throw new Error('ambient environment leaked');fs.copyFileSync(r.source_file,process.env.BITFIELD_PACKAGE_BUILD_OUTPUT);fs.chmodSync(process.env.BITFIELD_PACKAGE_BUILD_OUTPUT,0o755);\n",
  );
  await writeFile(path.join(packageRoot, 'things-to-store-and-run.json'), `${JSON.stringify({
    package: 'example',
    things: [{
      type: 'stored_bytes',
      name: 'example-bundle',
      build: {
        sequence: {
          steps: [{
            name: 'build',
            process: {
              argv: ['node', 'shared-package-set-builder'],
              cwd: '.',
              expected_termination: { kind: 'exited', code: 0 },
              containment: { kind: 'leaf' },
            },
            workspace_bindings: {
              environment: [],
              arguments: [{
                index: 1,
                parts: [
                  { kind: 'workspace_root' },
                  { kind: 'literal', value: '/scripts/shared-builder.mjs' },
                ],
              }],
            },
            predecessor_outputs: [],
          }],
        },
        output: { step: 'build', mount_path: '.bitfield-build-output' },
        request: { source_file: 'source/input.js' },
      },
    }],
  }, null, 2)}\n`);

  process.env.SHOULD_NOT_LEAK = 'secret';
  const results = await materializePackageStoredBytesBuilds(root);
  delete process.env.SHOULD_NOT_LEAK;
  assert.equal(results.length, 1);
  assert.equal(results[0].package, 'example');
  assert.equal(results[0].stored_bytes, 'example-bundle');
  assert.equal(await readFile(path.join(packageRoot, 'built-stored-bytes', 'example-bundle'), 'utf8'), 'export const answer = 42;\n');
  // The build's mode bits reach the package. A compiled executable that lands 0644 is
  // refused by the app-open authority on the customer machine (launcher, 2026-09-05).
  assert.equal((await stat(path.join(packageRoot, 'built-stored-bytes', 'example-bundle'))).mode & 0o111, 0o111);
  const data = JSON.parse(await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
  assert.equal(data.things[0].source_path, 'built-stored-bytes/example-bundle');
  assert.equal(existsSync(path.join(packageRoot, '.bitfield-build-output')), false);

  // The step is RE-RUNNABLE, and this is the assertion that matters. It used to read
  // `assert.equal('build' in data.things[0], false)`, pinning a delete that made
  // "already materialized" indistinguishable from "never had instructions", since the
  // loop skips entries with no `build`. The old test could only reach the script a
  // second time by hand-writing a build block back into the manifest, which is the
  // defect wearing the costume of test setup. A second call with NO hand-editing must
  // find the same work and redo it identically.
  assert.equal(data.things[0].build.request.source_file, 'source/input.js', 'the producer declaration survives its own use');
  process.env.SHOULD_NOT_LEAK = 'secret';
  const rerun = await materializePackageStoredBytesBuilds(root);
  delete process.env.SHOULD_NOT_LEAK;
  assert.equal(rerun.length, 1, 're-running finds the entry again instead of skipping it');
  assert.equal(rerun[0].byte_length, results[0].byte_length);
  assert.equal(await readFile(path.join(packageRoot, 'built-stored-bytes', 'example-bundle'), 'utf8'), 'export const answer = 42;\n');
  assert.equal((await stat(path.join(packageRoot, 'built-stored-bytes', 'example-bundle'))).mode & 0o111, 0o111);

  // SAME MEANING, SAME BYTES. The manifest is a build input of any entry that imports it,
  // and that entry's receipt pins the manifest's exact multihash. A run that materializes the
  // same blob into the already-declared path must not re-serialize the manifest, because
  // a reflowed one-line array changes the bytes under a receipt that is still true. The
  // author's layout is deliberately not the serializer's, so a rewrite is detectable.
  const authored = JSON.parse(await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
  const authoredText = `${JSON.stringify(authored, null, 2)}\n`.replace(
    '"predecessor_outputs": []',
    '"predecessor_outputs": [\n              ]',
  );
  assert.notEqual(authoredText, `${JSON.stringify(authored, null, 2)}\n`, 'fixture layout differs from the serializer');
  await writeFile(path.join(packageRoot, 'things-to-store-and-run.json'), authoredText);
  process.env.SHOULD_NOT_LEAK = 'secret';
  assert.equal((await materializePackageStoredBytesBuilds(root)).length, 1);
  delete process.env.SHOULD_NOT_LEAK;
  assert.equal(
    await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'),
    authoredText,
    'a build that changes no declaration leaves the manifest bytes exactly as authored',
  );

  // An entry carrying NO build block is still skipped. That is the legitimate meaning of
  // the skip, and the fix above must not have turned it into a rebuild attempt.
  const untouched = JSON.parse(await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
  untouched.things.push({ type: 'stored_bytes', name: 'hand-authored', source_path: 'source/input.js' });
  await writeFile(path.join(packageRoot, 'things-to-store-and-run.json'), `${JSON.stringify(untouched, null, 2)}\n`);
  assert.equal((await materializePackageStoredBytesBuilds(root)).length, 1, 'an entry with no build block is left alone');

  // A package may call a declared sibling package builder through the portable
  // package-set-root token. The materializer owns resolving that token; leaving
  // it literal makes Node look for a child named __PACKAGE_SET_ROOT__ below the
  // caller package and breaks every fresh projection while cached bytes hide it.
  const portable = JSON.parse(await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
  portable.things.push({
    type: 'stored_bytes',
    name: 'portable-root-token',
    build: {
      sequence: { steps: [{
        name: 'build',
        process: {
          argv: ['node', '__PACKAGE_SET_ROOT__/scripts/shared-builder.mjs'],
          cwd: '.',
          expected_termination: { kind: 'exited', code: 0 },
          containment: { kind: 'leaf' },
        },
        workspace_bindings: { environment: [], arguments: [] },
        predecessor_outputs: [],
      }] },
      output: { step: 'build', mount_path: '.bitfield-build-output' },
      request: { source_file: 'source/input.js' },
    },
  });
  await writeFile(path.join(packageRoot, 'things-to-store-and-run.json'), `${JSON.stringify(portable, null, 2)}\n`);
  const portableResults = await materializePackageStoredBytesBuilds(root);
  assert.equal(portableResults.length, 2);
  assert.equal(
    await readFile(path.join(packageRoot, 'built-stored-bytes', 'portable-root-token'), 'utf8'),
    'export const answer = 42;\n',
  );

  const unsupported = JSON.parse(await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
  unsupported.things[0].build = {
    sequence: { steps: [{ name: 'build', process: { argv: ['python3', '-c', 'pass'], cwd: '.', containment: { kind: 'leaf' } }, predecessor_outputs: [] }] },
    output: { step: 'build', mount_path: '.bitfield-build-output' },
  };
  await writeFile(path.join(packageRoot, 'things-to-store-and-run.json'), `${JSON.stringify(unsupported, null, 2)}\n`);
  await assert.rejects(() => materializePackageStoredBytesBuilds(root), /not a supported Node build profile/);
  // No assertion COUNT here. The line used to read `9 assertions passed`, and a hand-maintained
  // total is a number that goes wrong silently the first time someone adds a case, which is the
  // same defect as the hardcoded fixture denominator fixed elsewhere today. Reaching this line is
  // the result; every assertion above throws on failure.
  process.stdout.write('materialize-package-stored-bytes-builds: every assertion passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
