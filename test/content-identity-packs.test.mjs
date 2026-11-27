// The actual caller file-list packs must include the identity API's private compressor dependency.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, tools, folders, json } from '../test-helpers/tool-rows.mjs';

const callers = [];
for (const folder of folders) {
  const file = join(tools, folder, 'what-this-tool-does-and-how-to-run-it.json');
  if (!existsSync(file)) continue;
  for (const record of json(file).records ?? []) {
    const row = record.payload;
    const specs = [row?.invoke?.files?.package_files ?? []].flat();
    for (const identity of specs.filter(spec => spec.package === 'content-identity'
      && spec.paths?.includes('read-data/identity.mjs'))) {
      callers.push({ id: row.id, identity, dependencies: specs.filter(spec => spec.module === '@noble/hashes') });
    }
  }
}
assert.ok(callers.length, 'exercise at least one actual explicit identity pack');

const probe = `
import assert from 'node:assert/strict';
const api = await import(process.argv[1]);
const bytes = new TextEncoder();
assert.equal(api.makeHashCodeHexFromBytes(bytes.encode('abc')), '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
assert.equal(Buffer.from(api.makeDerivedKeyBytes(new Uint8Array(), bytes.encode('BLAKE3 2019-12-27 16:29:52 test vectors context'))).toString('hex'), '2cc39783c223154fea8dfb7c1b1660f2ac2dcbd1c1de8277b0b0dd39b7e50d7d');
const hash = api.blake3.create();
assert.equal(hash.constructor, api.AllocationAwareBLAKE3);
hash.destroy();
process.stdout.write('packed-identity-ok');
`;

for (const caller of callers) test(`${caller.id} packs the complete identity library at ${caller.identity.at}`, () => {
  const folder = tempFolder(join(tmpdir(), 'packed-content-identity-'));
  try {
    for (const spec of [caller.identity, ...caller.dependencies]) {
      const source = spec.module ? join(root, 'node_modules', spec.module) : join(tools, spec.package);
      for (const path of spec.paths) {
        const target = join(folder, spec.at, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(source, path), target, { recursive: true });
      }
    }
    const entry = pathToFileURL(join(folder, caller.identity.at, 'read-data/identity.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, entry], {
      encoding: 'utf8', cwd: folder, timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, 'packed-identity-ok');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
