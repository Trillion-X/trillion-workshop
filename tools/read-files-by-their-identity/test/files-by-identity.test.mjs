import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHashCodeHexFromBytes as identityOf } from '../../content-identity/read-data/identity.mjs';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { readByIdentity, keepByIdentity, keepPublishedFile, publishByIdentity, readPublishedFile, handleKeptFile, handleScreenModule } from '../read-data/files-by-identity.mjs';

function host() {
  const owners = new Map(), files = new Map(), published = new Map();
  const env = {
    OPERATOR_ACCOUNT_ID: 'service', PUBLISHED_FILE_BINDING: 'published',
    published: { async put(key,bytes) { published.set(key,bytes); }, async get(key) { const bytes = published.get(key); return bytes ? { arrayBuffer: async () => bytes } : null; } },
    identityFileHost: {
      fileOwners: { async keepFileOwner(id,owner) { owners.set(id,[...new Set([...(owners.get(id)??[]),owner])]); }, async fileOwners(id) { return owners.get(id)??[]; } },
      async keepStream(owner,file) { files.set(owner+file.identity,(await file.open())[0]); },
      async openFile(owner,id) { const bytes = files.get(owner+id); if (!bytes) throw new Error('gone'); return { stream: () => new Response(bytes).body }; },
      async serviceOwnerAsks(request) { return request.headers.get('x-proof')==='admitted'; },
    },
  };
  return {env,owners,files,published};
}

test('bytes are checked before storage and each account retains its independent copy', async () => {
  const s = host(), bytes = Uint8Array.of(1,2,3), identity = identityOf(bytes);
  await assert.rejects(keepByIdentity(s.env,'a',`1f:${'a'.repeat(64)}`,bytes),/not/);
  assert.equal(s.files.size,0);
  await keepByIdentity(s.env,'a',identity,bytes); await keepByIdentity(s.env,'b',identity,bytes);
  s.files.delete('a'+identity);
  assert.deepEqual(await readByIdentity(s.env,identity),bytes);
  s.files.set('b'+identity,Uint8Array.of(9));
  await assert.rejects(readByIdentity(s.env,identity),/do not match/);
});

test('published immutable bytes survive owner unavailability and are read back after publish', async () => {
  const s = host(), bytes = Uint8Array.of(4,5), identity = identityOf(bytes);
  await keepByIdentity(s.env,'a',identity,bytes); await publishByIdentity(s.env,identity);
  s.files.clear();
  assert.deepEqual(await readPublishedFile(s.env,identity),bytes);
  const response=await handleKeptFile(new Request(`https://service.example/workshop/files/${identity}`),s.env);
  assert.equal(response.status,200); assert.equal(response.headers.get('x-content-identity'),identity);
  assert.equal(response.headers.get('cache-control'),'public, max-age=31536000, immutable');
});

test('service publishing requires its admitted owner and refuses wrong bytes', async () => {
  const s=host(),bytes=Uint8Array.of(7),identity=identityOf(bytes);
  const url=`https://service.example/workshop/files/${identity}`;
  assert.equal((await handleKeptFile(new Request(url,{method:'POST',body:bytes}),s.env)).status,403);
  assert.equal((await handleKeptFile(new Request(url,{method:'POST',headers:{'x-proof':'admitted'},body:Uint8Array.of(8)}),s.env)).status,422);
  assert.equal(s.published.size,0);
});

test('module bundles unpack once found, missing bundles do not poison a later publication', async () => {
  const s=host(),bytes=tarGz([{name:'main.js',bytes:new TextEncoder().encode('export const x=1;')}]),identity=identityOf(bytes);
  const request=new Request(`https://service.example/workshop/modules/${identity}/main.js`);
  assert.equal((await handleScreenModule(request,s.env)).status,404);
  await keepPublishedFile(s.env,identity,bytes);
  const response=await handleScreenModule(request,s.env);
  assert.equal(await response.text(),'export const x=1;');
});

test('hash alone never opens private account Files without the admitted host', async () => {
  await assert.rejects(readByIdentity({},identityOf(Uint8Array.of(1))),error=>error.code==='identity_file_host_unavailable');
});
