import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashContent } from '../do-work/hash-content.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
const tool = fileURLToPath(new URL('../', import.meta.url));
const abc = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';

test('official BLAKE3 vectors: empty and abc', async () => {
  assert.deepEqual(await hashContent({text:'abc'}), {blake3:abc,identity:`1f:${abc}`,bytes:3});
  assert.equal((await hashContent({text:''})).blake3,'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
});
test('UTF-8 bytes preserve whitespace and normalization', async () => {
  const text = 'é\r\n🦋 ';
  const bytes = new TextEncoder().encode(text);
  assert.equal((await hashContent({text})).identity, makeHashCodeHexFromBytes(bytes));
  assert.equal((await hashContent({text})).bytes, bytes.length);
  assert.notEqual((await hashContent({text:'é'})).blake3,(await hashContent({text:'e\u0301'})).blake3);
});
test('Files hash raw binary, empty files and same bytes as text', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'blake3-files-'));
  for (const bytes of [Buffer.alloc(0),Buffer.from('abc'),Buffer.from([0,255,128,10])]) {
    await writeFile(path.join(root,'input'),bytes);
    assert.equal((await hashContent({path:'input'},root)).identity,makeHashCodeHexFromBytes(bytes));
  }
});
test('refuse invalid shapes, missing Files grants, traversal and symlink escapes', async () => {
  for (const input of [null,[],{}, {text:'x',path:'x'}, {text:3}, {path:''}, {path:'/etc/passwd'}, {text:'x',extra:true}]) {
    await assert.rejects(hashContent(input));
  }
  await assert.rejects(hashContent({path:'input'}),/granted Files folder/);
  const root = await mkdtemp(path.join(tmpdir(),'blake3-root-'));
  const outside = await mkdtemp(path.join(tmpdir(),'blake3-outside-'));
  await writeFile(path.join(outside,'secret'),'outside');
  await symlink(outside,path.join(root,'escape'));
  await assert.rejects(hashContent({path:'../outside'},root),/inside/);
  await assert.rejects(hashContent({path:'escape/secret'},root),/inside/);
  await assert.rejects(hashContent({path:'missing'},root),/ENOENT/);
  await assert.rejects(hashContent({path:'.'},root),/regular file/);
});
test('real JSON CLI returns result and nonzero JSON error', () => {
  const run = input => spawnSync(process.execPath,[path.join(tool,'do-work/hash-content.mjs')],{input,encoding:'utf8'});
  const good = run('{"text":"abc"}');
  assert.equal(good.status,0); assert.equal(JSON.parse(good.stdout).result.blake3,abc);
  for (const input of ['{','{}']) {const bad = run(input); assert.equal(bad.status,2); assert.ok(JSON.parse(bad.stdout).error);}
});
test('descriptor package mounts run without checkout imports', async () => {
  const descriptor = JSON.parse(await readFile(path.join(tool,'what-this-tool-does-and-how-to-run-it.json'),'utf8')).records[0].payload;
  const root = await mkdtemp(path.join(tmpdir(),'blake3-package-'));
  const workshop = path.resolve(tool,'../..');
  for (const mount of descriptor.invoke.files.package_files) {
    const base = mount.package ? path.join(workshop,'tools',mount.package) : path.join(workshop,mount.packages[0]);
    for (const source of mount.paths) {
      const dest = path.join(root,mount.at,source);
      await mkdir(path.dirname(dest),{recursive:true});
      await cp(path.join(base,source),dest,{recursive:true});
    }
  }
  const folder = path.join(root,'files'); await mkdir(folder); await writeFile(path.join(folder,'input'),'abc');
  const cli = path.join(root,descriptor.invoke.run[1]);
  const result = spawnSync(process.execPath,[cli,folder],{input:'{"path":"input"}',encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).result.blake3,abc);
});
