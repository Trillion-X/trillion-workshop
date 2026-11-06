// Ported from old trillion test/native-workshop-shared-files.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. fileInputs (src/workshop.mjs) and the shared input rules
// (src/shared-namespace-file-input.mjs) are this tool's and are imported directly instead of through an esbuild bundle
// with Worker stand-ins. The grant-bound supply they call, old src/native-workshop-shared-files.mjs
// nativeWorkshopSharedFiles over src/native-share-byte-carrier.mjs, is retired with no running successor (searched
// nativeWorkshopSharedFiles, nativeShareBytes, native-share-byte-carrier, 'exact requested range' and openShared across
// trillion-workshop tools, trillion-rust src and trillion-apps: only the callers here and a move-rows list), so the
// harness gives files.openShared as a small stand-in that checks a current grant on every open. Left out with that
// supply: 'each actual staged range mints current access after queued time', 'current revocation or changed selected
// identity refuses before a new staged range', 'the canonical grant-bound byte carrier withholds a chunk when rights
// change during its read', 'range staging refuses an ignored or changed range' and 'an exact empty shared file still
// checks its grant', which test only that supply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileInputs } from '../src/workshop.mjs';
import { sharedNamespaceFileInput, sharedNamespaceFileSource, placeSharedNamespaceFileInput } from '../src/shared-namespace-file-input.mjs';

const identity = `1f:${'a'.repeat(64)}`;
const reference = { identity, space_id: 'space_fixture', item_id: 'item_fixture' };
const bytes = new Uint8Array([11, 22, 33, 44]);
const denied = () => Object.assign(new Error('Current access was withdrawn.'), { status: 403 });

// Stand-in for the retired grant-bound supply: openShared checks the current grant, and its stream opens bytes only
// when a range is read (counted as leases and opens, as the old supply counted them).
function fixture() {
  let active = true, leases = 0, opens = 0;
  const rights = () => { if (!active) throw denied(); };
  const files = {
    async openShared(source) {
      rights();
      assert.deepEqual(source, reference);
      return { identity, byte_length: bytes.length, async stream(first = 0, last = bytes.length - 1) {
        rights(); leases++; opens++;
        return new Blob([bytes.slice(first, last + 1)]).stream();
      } };
    },
  };
  return { files, revoke() { active = false; }, counts: () => ({ leases, opens }) };
}

test('actual Workshop preflight stages shared sources while retaining only stable original task input', async () => {
  const schema = { type: 'object', properties: { edl: { format: 'namespace-file' } } };
  const durable = { edl: { spine: { segments: [{ source: reference }] } } };
  for (const sealed of [false, true]) {
    const f = fixture();
    const files = { ...f.files, open: () => assert.fail('A shared file is not a private file.'),
      readAddress: () => assert.fail('Shared execution does not retain/refetch an expiring URL.') };
    const placed = await fileInputs(durable, schema, files, { sealed });
    assert.equal(placed.placements.length, 1);
    assert.equal(placed.input.edl.spine.segments[0].source, placed.placements[0].path);
    assert.deepEqual(durable.edl.spine.segments[0].source, reference);
    assert.deepEqual(f.counts(), { leases: 0, opens: 0 });
    assert.deepEqual(new Uint8Array(await new Response(await placed.placements[0].open(0, 3)).arrayBuffer()), bytes);
  }
});

test('actual Workshop preflight refuses absent, malformed or withdrawn shared supplies without private fallback', async () => {
  const schema = { format: 'namespace-file' };
  const privateOnly = { open: () => assert.fail('No private fallback.'), readAddress: () => assert.fail('No private fallback.') };
  await assert.rejects(fileInputs(reference, schema, privateOnly), /no admitted shared file supply/);
  await assert.rejects(fileInputs({ ...reference, url: 'https://example.test/capability' }, schema, privateOnly), /exact identity/);
  const f = fixture(); f.revoke();
  await assert.rejects(fileInputs(reference, schema, f.files), /withdrawn/);
});

test('private Namespace inputs retain their ordinary sealed and networked execution contracts', async () => {
  const schema = { format: 'namespace-file' }, input = { clips: [{ source: identity }] };
  let opens = 0, addresses = 0;
  const files = { open: async asked => { assert.equal(asked, identity); opens++; return {
    identity, name: '/Recordings/clip.mp4', byte_length: 4, stream: () => new Blob([bytes]).stream(),
  }; }, readAddress: async asked => { assert.equal(asked, identity); addresses++; return 'https://private.test/admitted'; } };
  const networked = await fileInputs(input, schema, files);
  assert.equal(networked.input.clips[0].source, 'https://private.test/admitted');
  assert.equal(networked.placements.length, 0);
  const sealed = await fileInputs(input, schema, files, { sealed: true });
  assert.equal(sealed.input.clips[0].source, sealed.placements[0].path);
  assert.equal(opens, 1); assert.equal(addresses, 1);
  assert.equal(input.clips[0].source, identity);
});

test('shared task inputs keep exact stable coordinates and never reinterpret them as private identities', async () => {
  assert.deepEqual(sharedNamespaceFileSource(identity, reference), reference);
  assert.equal(sharedNamespaceFileInput({ source: identity }), null);
  for (const input of [{ identity, space_id: reference.space_id }, { ...reference, url: 'https://untrusted.test?lease=must-not-be-kept' },
    { ...reference, identity: 'not-a-file' }]) assert.throws(() => sharedNamespaceFileInput(input));
  assert.throws(() => sharedNamespaceFileSource(identity, {}));
  let privateReads = 0;
  await assert.rejects(placeSharedNamespaceFileInput(reference, { open() { privateReads++; } }, []), /no admitted shared file supply/);
  assert.equal(privateReads, 0);
});

test('identical bytes deduplicate the actual staging path only after checking every selected grant', async () => {
  const f = fixture(), placements = [];
  await placeSharedNamespaceFileInput(reference, f.files, placements);
  f.revoke();
  await assert.rejects(placeSharedNamespaceFileInput(reference, f.files, placements), /withdrawn/);
  assert.equal(placements.length, 1);
  assert.deepEqual(f.counts(), { leases: 0, opens: 0 });
});
