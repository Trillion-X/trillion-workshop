import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import esbuild from 'esbuild';
import { createPackageEntryAtAliasPlugin } from '../do-work/package-entry-at-alias.mjs';

test('package-set imports win while vendored source imports resolve locally', async () => {
  const root = tempFolder(path.join(tmpdir(), 'bitfield-at-alias-'));
  try {
    const source = path.join(root, 'packages', 'ui', 'show', 'vendor', 'source');
    mkdirSync(path.join(source, 'lib'), { recursive: true });
    mkdirSync(path.join(source, 'packages', 'shared'), { recursive: true });
    mkdirSync(path.join(root, 'packages', 'shared'), { recursive: true });
    writeFileSync(path.join(source, 'lib', 'utils.ts'), 'export const local = "local";');
    writeFileSync(path.join(source, 'packages', 'shared', 'value.ts'), 'export const global = "wrong";');
    writeFileSync(path.join(root, 'packages', 'shared', 'value.ts'), 'export const global = "global";');
    writeFileSync(path.join(source, 'entry.ts'),
      'import { local } from "@/lib/utils"; import { global } from "@/packages/shared/value"; export const result = local + global;');
    const built = await esbuild.build({
      entryPoints: [path.join(source, 'entry.ts')], bundle: true, write: false, format: 'esm',
      plugins: [createPackageEntryAtAliasPlugin({ packageSetRoot: root })],
    });
    const output = built.outputFiles[0].text;
    assert.match(output, /local/);
    assert.match(output, /global/);
    assert.doesNotMatch(output, /wrong/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a source-local alias cannot follow a symlink outside the selected set', async () => {
  const root = tempFolder(path.join(tmpdir(), 'bitfield-at-alias-root-'));
  const outside = tempFolder(path.join(tmpdir(), 'bitfield-at-alias-outside-'));
  try {
    const source = path.join(root, 'packages', 'ui', 'show', 'vendor', 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(outside, 'utils.ts'), 'export const secret = "outside";');
    symlinkSync(outside, path.join(source, 'lib'));
    writeFileSync(path.join(source, 'entry.ts'), 'export { secret } from "@/lib/utils";');
    await assert.rejects(() => esbuild.build({
      entryPoints: [path.join(source, 'entry.ts')], bundle: true, write: false,
      plugins: [createPackageEntryAtAliasPlugin({ packageSetRoot: root })],
    }), /escaped the selected package set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
