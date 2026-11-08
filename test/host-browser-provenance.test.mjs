// These checks validate the registered custody/lineage record only. The 24 executable browser bodies and their
// complete assertion-token custody checks run in Apps CI; this public test never reads the private Apps checkout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../tools/content-identity/read-data/identity.mjs';
import provenance from './host-browser-provenance.json' with { type: 'json' };

const ORIGINAL_CHECKS = '1f:db2e092d5097064bd3af0df74a2edfdf4b81d0b48769b4115a1a50061e37061a';
const original = file => ({ original: file.original, source_identity: file.source_identity, test_names: file.test_names, assertions: file.assertions, assertion_identity: file.assertion_identity });

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
  for (const file of document.files) {
    assert.match(file.consumer, /^web\/test\/[a-z-]+\.test\.mjs$/);
    assert.equal(file.original_snapshot_identity, file.source_identity);
    assert.equal(file.consumer_url, 'https://github.com/Trillion-X/trillion-apps/blob/' + document.receipt.tested_head + '/' + file.consumer);
    const pointer = readFileSync(new URL('../' + file.original, import.meta.url));
    assert.equal(makeHashCodeHexFromBytes(pointer), file.pointer_identity, file.original);
    assert.ok(pointer.toString().includes(file.consumer_url), file.original);
    assert.ok(pointer.toString().includes(document.receipt.run_url), file.original);
    const pieces = file.original.split('/');
    const moved = JSON.parse(readFileSync(new URL('../' + pieces.slice(0, 2).join('/') + '/moved-from.json', import.meta.url), 'utf8'));
    const lineage = moved.files.find(row => row.to === file.original);
    assert.ok(lineage, file.original);
    assert.equal(lineage.identity, file.pointer_identity, file.original);
    assert.deepEqual(lineage.published_test_custody, { receipt: 'test/host-browser-provenance.json', entry: file.original });
  }
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
