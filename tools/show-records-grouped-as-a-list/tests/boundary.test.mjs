import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRecordProjectionDescriptor } from '../read-data/read-record-projection.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...(await filesUnder(path)));
    if (entry.isFile()) paths.push(path);
  }
  return paths;
}

test('boundary and projection descriptor parse from source workshop', async () => {
  const boundary = await readJson(join(packageRoot, 'things-to-store-and-run.json'));
  const descriptors = await readJson(join(packageRoot, 'data/record-projection-descriptors.json'));

  assert.equal(boundary.package, 'group-list');
  assert.ok(Array.isArray(boundary.things));
  validateRecordProjectionDescriptor(descriptors.projection);

  const storedPaths = new Set(
    boundary.things
      .filter((thing) => thing.type === 'stored-bytes')
      .map((thing) => thing.path),
  );
  assert.ok(storedPaths.has('read-data/read-record-projection.mjs'));
  assert.ok(storedPaths.has('do-work/invoke-record-action.mjs'));
  console.log('[group-list] generic boundary loaded');
});

test('boundary rejects duplicate platform owners and package-local execution shortcuts', async () => {
  // GENERATED output is not source. This walk excluded only /tests/ and /proof/, so it also read
  // `.bitfield-entry-scope/`, whose files announce themselves with
  // "Generated from things-to-store-and-run.json package entry records. Do not edit." and are
  // re-emitted from the boundary, so judging them is judging the generator's output rather than
  // anyone's decision. Same exclusion the declared corpus rules already carry in
  // scope.path_excludes, and the second package found with this exact gap on 2026-09-04, which is
  // why it is worth a comment rather than a silent filter: 18 packages hand-roll this walk and
  // most of them do not exclude generated output yet.
  const generated = /\/(\.bitfield-entry-scope|built-stored-bytes|node_modules)\//;
  const files = (await filesUnder(packageRoot)).filter(
    (file) => !file.includes('/tests/') && !file.includes('/proof/') && !generated.test(file),
  );
  const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

  assert.doesNotMatch(text, /group-list-mobile|group-watch|group-kiosk|group-list-background/);
  assert.doesNotMatch(text, /fetch\s*\(|credentials-vault|access-rule|relationship-graph|notification-delivery/);
});

test('descriptor keeps extensible methods and values open', async () => {
  const descriptors = await readJson(join(packageRoot, 'data/record-projection-descriptors.json'));
  const descriptorText = JSON.stringify(descriptors.projection);

  assert.match(descriptorText, /"method"/);
  assert.match(descriptorText, /"params"/);
  assert.doesNotMatch(descriptorText, /"enum"\s*:/);
  assert.doesNotMatch(descriptorText, /"oneOf"\s*:/);
  assert.doesNotMatch(descriptorText, /"anyOf"\s*:/);
  console.log('[group-list] open descriptor guard passed');
});
