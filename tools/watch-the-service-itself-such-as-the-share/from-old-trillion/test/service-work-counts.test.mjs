// Calibrate the retained counter, including real maintained-source readback. These checks do not grant allowances.
import assert from 'node:assert/strict';
import test from 'node:test';
import { maintainedServiceSources, withOriginalAllowanceKeys } from './service-work-sources.mjs';
import allowance from './service-work-allowance.json' with { type: 'json' };
import configuration from './service-work-sources.json' with { type: 'json' };
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

test('only an exact committed move retains its historical allowance identity', () => {
  const text = '{"setting":"OPERATOR_ACCOUNT_ID"}';
  const source = { repository: 'sample-owner', path: 'settings/host.json', key: 'sample-owner:settings/host.json', text };
  const move = { repository: source.repository, path: source.path, moved_at: 'move', source: { repository: 'original-owner', commit: 'original', path: 'src/host.json' } };
  const read = () => Buffer.from(text);
  assert.equal(withOriginalAllowanceKeys([source], [move], read)[0].key, 'src/host.json');
  for (const changed of [
    { ...source, text: `${text}\n` },
    { ...source, path: 'settings/new-host.json', key: 'sample-owner:settings/new-host.json' },
    { ...source, repository: 'unrelated-owner', key: 'unrelated-owner:settings/host.json' },
  ]) assert.equal(withOriginalAllowanceKeys([changed], [move], read)[0].key, changed.key);
  assert.throws(() => withOriginalAllowanceKeys([source], [move], () => null), /lineage/);
  assert.throws(() => withOriginalAllowanceKeys([source], [move], ref => Buffer.from(ref.commit)), /lineage/);
  assert.throws(() => withOriginalAllowanceKeys([source], [move, move], read), /ambiguous/);
  assert.throws(() => withOriginalAllowanceKeys([source, source], [move], read), /share an allowance/);
});

test('a new service-write selection cannot borrow a moved personal allowance or hide behind duplicate counts', () => {
  const text = '{"setting":"OPERATOR_ACCOUNT_ID"}';
  const source = { repository: 'sample-owner', path: 'settings/host.json', key: 'sample-owner:settings/host.json', text };
  const move = { repository: source.repository, path: source.path, moved_at: 'move', source: { repository: 'original-owner', commit: 'original', path: 'src/host.json' } };
  const [changed] = withOriginalAllowanceKeys([{ ...source, text: '{"setting":"OPERATOR_ACCOUNT_ID","service_work_setting":"OPERATOR_ACCOUNT_ID"}' }], [move], () => Buffer.from(text));
  const counts = serviceWorkCountsFromSources([changed]);
  assert.equal(counts[changed.key], 2);
  assert.ok(counts[changed.key] > (allowance.files[changed.key]?.count ?? 0));
  assert.equal(counts['src/host.json'], undefined);
  assert.deepEqual(serviceWorkCountsFromSources([source, source]), { [source.key]: 2 });
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
  for (const move of configuration.moved_allowance_sources) {
    const retained = sources.find(source => source.repository === move.repository && source.path === move.path);
    assert.equal(retained?.key, move.source.path, 'current bytes retain only the authenticated original identity');
    assert.deepEqual(serviceWorkCountsFromSources([retained]), { [move.source.path]: 1 });
    assert.equal(allowance.files[move.source.path].count, 1);
  }
  assert.deepEqual(allowance.files['src/service-watch.json'].runtime_calls, [], 'retired PersonStore runtime calls are not revived');
  t.diagnostic(JSON.stringify({ sources: sources.length, revisions: Object.fromEntries(sources.map(source => [source.repository, source.revision])), matched: serviceWorkCountsFromSources(sources) }));
});
