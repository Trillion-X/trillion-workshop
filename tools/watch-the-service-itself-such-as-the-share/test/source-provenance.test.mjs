import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../../check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../../check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';
const root=new URL('../../../',import.meta.url).pathname;
const originalRepository=new URL('../../../../trillion/',import.meta.url).pathname;
const contract=JSON.parse(readFileSync(new URL('../ports/read-service-usage.json',import.meta.url)));
test('the held preadaptation slice equals the actual original source and committed immutable baseline',()=>{
 const source=execFileSync('git',['show',`${contract.sources[0].commit}:src/service-watch.mjs`],{cwd:originalRepository,encoding:'utf8'}).split('\n').slice(404,425).join('\n')+'\n';
 const baseline=execFileSync('git',['show',`${contract.baseline.commit}:${contract.baseline.path}`],{cwd:root});
 assert.equal(source,baseline.toString());
 assert.equal(makeHashCodeHexFromBytes(baseline),contract.baseline.source_multihash);
 assert.deepEqual(readFileSync(new URL('../source-baselines/ask-provider.mjs.held',import.meta.url)),baseline);
});
test('source-first adaptation remains checked against its real repository history and retained lines',()=>{
 const result=validateReferenceAdaptationContract(contract,{stage:'completion',readers:gitReaders({root,repositories:{trillion:originalRepository}})});
 assert.equal(result.valid,true,JSON.stringify(result));
 assert.deepEqual(result.deferred,[]);
});
