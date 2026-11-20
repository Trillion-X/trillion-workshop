import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const esbuild = path.resolve(process.cwd(), 'node_modules/.bin/esbuild');
const routes = [
  ['manifest', 'app-api-experience-manifest-route.ts.txt', 'GET', new Request('https://buyer/'), { experienceRef: 'publication:one' }],
  ['bytes', 'app-api-experience-bytes-route.ts.txt', 'GET', new Request('https://buyer/'), { experienceRef: 'publication:one', byteRef: ['app.js'] }],
  ['data', 'app-api-experience-data-route.ts.txt', 'GET', new Request('https://buyer/?ref=data:one'), { experienceRef: 'publication:one' }],
  ['subscription', 'app-api-experience-subscriptions-route.ts.txt', 'POST', new Request('https://buyer/', { method: 'POST', body: JSON.stringify({ refs: ['sub:one'] }) }), { experienceRef: 'publication:one' }],
  ['target', 'hosted-target-route.ts.txt', 'POST', new Request('https://buyer/', { method: 'POST', headers: { origin: 'https://buyer', 'x-bitfield-experience-ref': 'publication:one' }, body: '{}' }), { target: ['target:one'] }],
];

test('all protected route modules compile and pass only route-derived publication/ref inputs into shared authority', async () => {
  const dir = tempFolder(path.join(tmpdir(), 'hpa-protected-routes-'));
  writeFileSync(path.join(dir, 'authority.ts'), `
const calls=globalThis.__hpaCalls ??= []; export async function resolveHostedExperienceAuthority(...v){calls.push(['resolve',...v]);return {ok:true}}
export function safeAuthorityError(){return Response.json({ok:false},{status:404})}
export function publicExperienceManifest(){return {ok:'manifest'}}
export async function invokeEntryProjectionTarget(){calls.push(['entry-projection']);return {}}
export async function readAuthorizedBytes(_a,ref){calls.push(['bytes',ref]);return {bytes:new Uint8Array([1]),contentType:'application/octet-stream',multihash:'1f:bytes'}}
export async function readAuthorizedData(_a,ref){calls.push(['data',ref]);return {ok:ref}}
export async function readAuthorizedSubscriptions(_a,refs){calls.push(['subscription',refs]);return {refs}}
export async function invokeSessionAdmittedTarget(_a,target,payload){calls.push(['target',target,payload]);return {ok:target}}
`);
  for (const [name, source, method, request, params] of routes) {
    const staged = path.join(dir, `${name}.ts`);
    writeFileSync(staged, readFileSync(path.join(root, 'read-data/artifacts', source), 'utf8').replace(/from "(?:\.\.\/)+stored-artifacts\/hosted-experience-authority"/, 'from "./authority.ts"'));
    const output = path.join(dir, `${name}.mjs`);
    execFileSync(esbuild, [staged, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`], { cwd: dir, stdio: 'pipe' });
    const module = await import(`${pathToFileURL(output).href}?${Date.now()}-${name}`);
    const response = await module[method](request, { params: Promise.resolve(params) });
    assert.equal(response.status, 200, name);
    if (name === 'target') {
      const missingOrigin = await module.POST(
        new Request('https://buyer/', { method: 'POST', headers: { 'x-bitfield-experience-ref': 'publication:one' }, body: '{}' }),
        { params: Promise.resolve(params) },
      );
      assert.deepEqual(await missingOrigin.json(), { ok: false, code: 'origin-denied' });
      const rawTarget = await module.POST(
        new Request('https://buyer/', { method: 'POST', headers: { origin: 'https://buyer', 'x-bitfield-experience-ref': 'publication:one' }, body: '{}' }),
        { params: Promise.resolve({ target: ['slot::workflow'] }) },
      );
      assert.deepEqual(await rawTarget.json(), { ok: false, code: 'raw-or-malformed-target' });
    }
  }
  const calls = globalThis.__hpaCalls;
  assert.deepEqual(calls.filter(([kind]) => kind === 'resolve').map(([, , ref, operation]) => [ref, operation]), [
    ['publication:one', 'manifest'], ['publication:one', 'bytes'], ['publication:one', 'data'], ['publication:one', 'subscription'], ['publication:one', 'target'],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind !== 'resolve'), [
    ['bytes', ['app.js']], ['data', 'data:one'], ['subscription', ['sub:one']], ['target', 'target:one', {}],
  ]);
});
