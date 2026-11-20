import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyDeclaredSource } from '../do-work/copy-declared-source.mjs';

test('copies one declared package-owned source byte for byte', async () => {
  const root = tempFolder(path.join(tmpdir(), 'copy-declared-source-'));
  await mkdir(path.join(root, 'show'));
  await writeFile(path.join(root, 'show', 'entry.js'), 'export default 1;\n');
  const output = path.join(root, 'output.bin');
  await copyDeclaredSource({ packageRoot: root, sourceFile: 'show/entry.js', outputFile: output });
  assert.equal(await readFile(output, 'utf8'), 'export default 1;\n');
});

test('refuses a source outside the package owner', async () => {
  const root = tempFolder(path.join(tmpdir(), 'copy-declared-source-owner-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
  await writeFile(outside, 'stolen');
  await assert.rejects(
    copyDeclaredSource({ packageRoot: root, sourceFile: outside, outputFile: path.join(root, 'out') }),
    /outside the package owner/,
  );
});
