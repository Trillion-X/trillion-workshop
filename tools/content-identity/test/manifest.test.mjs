// The folder identity moved here from tools/workflows/do-work/pin-a-commit-by-its-files.mjs is the same identity: the
// golden pins of two real Workshop folders at 01c2cc3a2 (the registry's first two pointers), the pin module no longer
// exporting its own copies, and a path named twice refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileDigest, identityOfDigests, manifestIdentity, tarFiles } from '../read-data/manifest.mjs';
import * as identity from '../read-data/identity.mjs';
import * as pin from '../../workflows/do-work/pin-a-commit-by-its-files.mjs';

const workshop = resolve(import.meta.dirname, '../../..');
const COMMIT = '01c2cc3a271f56ae6799b20501ab6153057aeb69';
const folderAt = tool => tarFiles(execFileSync('git', ['-C', workshop, 'archive', '--format=tar', COMMIT, `tools/${tool}`], { maxBuffer: 1 << 30 }))
  .map(([path, bytes]) => [path.slice(`tools/${tool}/`.length), bytes]);

test('the moved manifestIdentity gives the golden pins at 01c2cc3a2', () => {
  assert.equal(manifestIdentity(folderAt('hash-content-with-blake3')), 'e76a4ee0d6269a8e39172437d30f06be32353053bb0701c525df473ab3e61a06');
  assert.equal(manifestIdentity(folderAt('content-identity')), '7d9e45feea11f2842e6c49bc282d9a14bcacb09879865edaf2c167d99ce50428');
});

test('a file digest is the identity owner\'s, bare', () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(fileDigest(bytes), identity.makeHashCodeHexFromBytes(bytes).slice(3));
});

test('identity of digests is the manifest identity of the files', () => {
  const files = [['b', Buffer.from('2')], ['a', Buffer.from('1')], ['10', Buffer.from('3')]];
  assert.equal(identityOfDigests(Object.fromEntries(files.map(([p, b]) => [p, fileDigest(b)]))), manifestIdentity(files));
  assert.throws(() => identityOfDigests([['a', 'x'], ['a', 'y']]), /named twice/);
});

test('the pin module keeps no copy of its own', () => {
  assert.equal('tarFiles' in pin, false);
  assert.equal('manifestIdentity' in pin, false);
});
