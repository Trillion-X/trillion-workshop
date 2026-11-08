// These checks validate the registered custody/lineage records only. The executable browser and cover bodies
// and complete assertion-token custody checks run in Apps CI; this public test never reads the private checkout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../tools/content-identity/read-data/identity.mjs';
import provenance from './host-browser-provenance.json' with { type: 'json' };

const ORIGINAL_CHECKS = '1f:db2e092d5097064bd3af0df74a2edfdf4b81d0b48769b4115a1a50061e37061a';
const original = file => ({ original: file.original, source_identity: file.source_identity, test_names: file.test_names, assertions: file.assertions, assertion_identity: file.assertion_identity });

function verifiedPointers(files, head, runUrls) {
  for (const file of files) {
    assert.equal(file.original_snapshot_identity, file.source_identity);
    assert.equal(file.consumer_url, 'https://github.com/Trillion-X/trillion-apps/blob/' + head + '/' + file.consumer);
    const pointer = readFileSync(new URL('../' + file.original, import.meta.url));
    assert.equal(makeHashCodeHexFromBytes(pointer), file.pointer_identity, file.original);
    assert.ok(pointer.toString().includes(file.consumer_url), file.original);
    for (const url of runUrls) assert.ok(pointer.toString().includes(url), file.original);
    const pieces = file.original.split('/');
    const moved = JSON.parse(readFileSync(new URL('../' + pieces.slice(0, 2).join('/') + '/moved-from.json', import.meta.url), 'utf8'));
    const lineage = moved.files.find(row => row.to === file.original);
    assert.ok(lineage, file.original);
    assert.equal(lineage.identity, file.pointer_identity, file.original);
    assert.deepEqual(lineage.published_test_custody, { receipt: 'test/host-browser-provenance.json', entry: file.original });
  }
}

function verifiedCustody(document) {
  assert.equal(document.schema, 'published-test-custody/v1');
  assert.equal(document.source, 'Trillion-X/trillion-workshop');
  assert.equal(document.consumer_repository, 'Trillion-X/trillion-apps');
  assert.equal(document.receipt.tested_head, '05a62842ab9ad4111f6ce2e3e15d1692ba27c571');
  assert.equal(document.receipt.merge_commit, '8c4bfb0c3aa77355fecb72ff5c45c8c720930daf');
  assert.equal(document.receipt.run_id, '42474527945');
  assert.equal(document.receipt.job_id, '128712760466');
  assert.equal(document.receipt.conclusion, 'success');
  assert.deepEqual([document.receipt.tests, document.receipt.passed, document.receipt.failed, document.receipt.cancelled, document.receipt.skipped], [26, 26, 0, 0, 0]);
  assert.deepEqual([document.receipt.original_browser_tests, document.receipt.custody_tests, document.receipt.original_assertions], [24, 2, 179]);
  assert.equal(document.files.length, 6);
  assert.equal(makeHashCodeHexFromJson(document.files.map(original)), ORIGINAL_CHECKS, 'the six original lineages, literal titles and assertion identities remain unchanged');
  assert.equal(new Set(document.files.map(file => file.consumer)).size, 6);
  assert.equal(document.files.flatMap(file => file.test_names).length, 24);
  assert.equal(document.files.reduce((sum, file) => sum + file.assertions, 0), 179);
  for (const file of document.files) assert.match(file.consumer, /^web\/test\/[a-z-]+\.test\.mjs$/);
  verifiedPointers(document.files, document.receipt.tested_head, [document.receipt.run_url]);
}

test('the six original browser files point to verified published Apps custody for all 24 bodies and 179 assertions', () => verifiedCustody(provenance));

test('custody metadata refuses a red or skipped run, a changed original check, and a different tested head', () => {
  for (const mutate of [
    document => { document.receipt.conclusion = 'failure'; },
    document => { document.receipt.skipped = 1; },
    document => { document.files[0].test_names[0] += ' changed'; },
    document => { document.files[0].assertions -= 1; },
    document => { document.receipt.tested_head = '0'.repeat(40); },
  ]) { const changed = structuredClone(provenance); mutate(changed); assert.throws(() => verifiedCustody(changed)); }
});


const COVER_CHECKS = '1f:a87482e6d5cd2fe42079786515eaee31b79f3b2900582ec54c0d2fac6cd0bd5c';

function verifiedCoverCustody(document) {
  const { receipt, files } = document;
  assert.equal(receipt.pull_request_head, '3cca347079395fddd2b3331a05b4956af3829449');
  assert.equal(receipt.ci_merge_checkout, '78ecdf401ec6f63076386635de9276c85c3cbc94');
  assert.equal(receipt.ci_base, '8c4bfb0c3aa77355fecb72ff5c45c8c720930daf');
  assert.equal(receipt.ci_checkout_kind, 'pull-request merge of the exact PR head into the prior published main');
  assert.equal(receipt.merge_commit, '4106a2cd5358c2ad89834cbbf7e09c6958c50842');
  assert.equal(receipt.run_id, '42480062743');
  assert.equal(receipt.conclusion, 'success');
  assert.deepEqual(receipt.jobs.map(job => [job.platform, job.job_id, job.tests, job.passed, job.failed, job.cancelled, job.skipped]), [
    ['ubuntu-latest', '128729848199', 32, 32, 0, 0, 0],
    ['macos-latest', '128729848422', 6, 6, 0, 0, 0],
  ]);
  assert.deepEqual([receipt.original_cover_tests, receipt.original_assertions, receipt.cover_custody_tests], [4, 10, 1]);
  assert.equal(files.length, 1);
  assert.equal(makeHashCodeHexFromJson(files.map(original)), COVER_CHECKS, 'the four original cover titles and all ten assertion identities remain unchanged');
  assert.equal(files[0].original, 'tools/organize-my-files/test/thread-cover.test.mjs');
  assert.equal(files[0].consumer, 'test/thread-cover.test.mjs');
  assert.equal(files[0].source_commit, '1083a00ae322107c47e76d82e9c641789d0fd176');
  assert.equal(files[0].original_snapshot, 'test/workshop-cover-provenance/thread-cover.test.mjs.source');
  verifiedPointers(files, receipt.pull_request_head, receipt.jobs.map(job => job.url));
  const moved = JSON.parse(readFileSync(new URL('../tools/organize-my-files/moved-from.json', import.meta.url), 'utf8'));
  const lineage = moved.files.find(row => row.to === files[0].original);
  assert.equal(lineage.from, 'test/thread-cover.test.mjs');
  assert.equal(lineage.commit, '1e886c3f68828439c545f34bbef0e415055a800f');
  assert.equal(lineage.source_identity, '1f:311f68154aea6f8fa5709ae5fac7044f207ef3b6d38bf3236b6ea06413691521');
}

test('the four original cover bodies have published custody while their original filename and lineage remain', () => verifiedCoverCustody(provenance.cover));

test('cover custody refuses a different CI checkout, a changed original assertion, and incomplete hosted jobs', () => {
  for (const mutate of [
    document => { document.receipt.ci_merge_checkout = '0'.repeat(40); },
    document => { document.receipt.pull_request_head = '0'.repeat(40); },
    document => { document.files[0].assertion_identity = '1f:' + '0'.repeat(64); },
    document => { document.files[0].test_names[0] += ' changed'; },
    document => { document.receipt.jobs[0].skipped = 1; },
    document => { document.receipt.jobs[1].failed = 1; },
  ]) { const changed = structuredClone(provenance.cover); mutate(changed); assert.throws(() => verifiedCoverCustody(changed)); }
});
