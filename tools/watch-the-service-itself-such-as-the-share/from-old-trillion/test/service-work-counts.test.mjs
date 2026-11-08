// Calibrate the retained counter, including real maintained-source readback. These checks do not grant allowances.
import assert from 'node:assert/strict';
import test from 'node:test';
import { maintainedServiceSources } from './service-work-sources.mjs';
import { serviceWorkCounts, serviceWorkCountsFromSources } from './service-work-counts.mjs';

test('every original bad call and DATA-selection shape is still detected', () => {
  for (const [id, text, extension] of [
    ['operator-store', 'operatorStore(env).putServiceRules(value);', 'mjs'],
    ['operator-person-get', 'env.PERSON.get(env.OPERATOR_ACCOUNT_ID).putServiceRules(value);', 'mjs'],
    ['operator-person-for', 'personFor(ctx, env.OPERATOR_ACCOUNT_ID).putServiceRules(value);', 'mjs'],
    ['operator-in-id-list', 'const people = [env.OPERATOR_ACCOUNT_ID];', 'mjs'],
    ['operator-setting-constant', "const service = 'OPERATOR_ACCOUNT_ID';", 'mjs'],
    ['data-names-operator', '{"service_work_setting":"OPERATOR_ACCOUNT_ID"}', 'json'],
    ['operator-id-held', 'const recipient = env.OPERATOR_ACCOUNT_ID;', 'mjs'],
    ['operator-owner-id', 'const store = env.PERSON.idFromName(env.OPERATOR_ACCOUNT_ID).toString();', 'mjs'],
  ]) assert.deepEqual(serviceWorkCountsFromSources([{ path: `source.${extension}`, text }], { only: [id] }), { [`source.${extension}`]: 1 }, id);
});

test('comments and the original helper-definition exception remain good cases', () => {
  assert.deepEqual(serviceWorkCountsFromSources([{ path: 'source.mjs', text: '// operatorStore(env).putServiceRules(value);' }]), {});
  assert.deepEqual(serviceWorkCountsFromSources([{ path: 'source.mjs', text: 'export const operatorStore = env => env.PERSON.get(env.OPERATOR_ACCOUNT_ID);' }]), {});
});

test('empty, unreadable and unavailable source evidence cannot pass as zero calls', () => {
  assert.throws(() => serviceWorkCountsFromSources([]), /empty or unavailable/);
  assert.throws(() => serviceWorkCountsFromSources([{ path: 'source.mjs' }]), /could not be read/);
  assert.throws(() => maintainedServiceSources('/workshop-guard-source-that-does-not-exist'), /no declared source package/);
  assert.throws(() => serviceWorkCounts('/workshop-guard-source-that-does-not-exist'), /ENOENT|empty or unavailable/);
});

test('the real maintained inventory is nonempty and retains the report-recipient allowance identity', t => {
  const sources = maintainedServiceSources();
  assert.equal(new Set(sources.map(source => source.repository)).size, 3);
  assert.ok(sources.every(source => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision)));
  const report = sources.find(source => source.key === 'records/workshop-tray-tool-records.json');
  assert.ok(report, 'the report recipient is read from its maintained source, not an empty archive');
  assert.deepEqual(serviceWorkCountsFromSources([report]), { 'records/workshop-tray-tool-records.json': 1 });
  const native = sources.find(source => source.path === 'src/local_account/service_records.rs');
  assert.ok(native, 'the native record capability source is part of the source evidence');
  t.diagnostic(JSON.stringify({ sources: sources.length, revisions: Object.fromEntries(sources.map(source => [source.repository, source.revision])), matched: serviceWorkCountsFromSources(sources) }));
});
