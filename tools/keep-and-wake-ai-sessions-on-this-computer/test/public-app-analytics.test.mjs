import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checkedPublicAppDefinition } from '../../edit-a-site-visually/src/public-app-definition.mjs';
import { installPublicApp, recordPublicAppVisitorAction } from '../../shared-code/src/public-app-records.mjs';
import { publicAppAnalytics, recordPublicAppPageView, updatePublicAppInstallationDefinition } from '../../shared-code/src/public-app-analytics.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec(query, ...values) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) return { toArray: () => statement.all(...values) };
    statement.run(...values);
    return { toArray: () => [] };
  } };
}

const originalDefinition = checkedPublicAppDefinition({
  id: 'studio-site', version: 'publication',
  actions: [{ id: 'apply', record_kind: 'studio-inquiry', fields: [{ id: 'email', type: 'email', required: true }] }],
});
const changedDefinition = checkedPublicAppDefinition({
  id: 'studio-site', version: 'publication',
  actions: [{ id: 'apply', record_kind: 'studio-inquiry', fields: [{ id: 'email', type: 'email', required: true }, { id: 'note', type: 'text' }] }],
});

test('analytics counts HTML views and unique first-party visitors per installation without storing the cookie token', () => {
  const sql = sqlite();
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  installPublicApp(sql, { installation_id: a, definition: originalDefinition, context: { kind: 'private', id: 'owner-a' }, installed_by: 'owner-a' });
  installPublicApp(sql, { installation_id: b, definition: originalDefinition, context: { kind: 'space', id: 'space-b' }, installed_by: 'relay-b' });
  const first = { installation_id: a, page_path: '/', visitor_token: 'visitor-token-0001', view_id: 'page-view-00000001', viewed_at: '2026-10-01T10:00:00.000Z' };
  assert.equal(recordPublicAppPageView(sql, first).recorded, true);
  assert.equal(recordPublicAppPageView(sql, first).recorded, false);
  recordPublicAppPageView(sql, { ...first, page_path: '/about', view_id: 'page-view-00000002', viewed_at: '2026-10-01T10:02:00.000Z' });
  recordPublicAppPageView(sql, { ...first, visitor_token: 'visitor-token-0002', view_id: 'page-view-00000003', viewed_at: '2026-10-02T11:00:00.000Z' });
  recordPublicAppPageView(sql, { ...first, installation_id: b, view_id: 'page-view-00000004' });
  const report = publicAppAnalytics(sql, a, { from: '2026-10-01', to: '2026-10-02' });
  assert.deepEqual({ page_views: report.page_views, unique_visitors: report.unique_visitors, submissions: report.submissions }, { page_views: 3, unique_visitors: 2, submissions: 0 });
  assert.deepEqual(report.pages, [
    { path: '/', page_views: 2, unique_visitors: 2 },
    { path: '/about', page_views: 1, unique_visitors: 1 },
  ]);
  assert.equal(report.days.length, 2);
  assert.equal(report.days[0].unique_visitors, 1);
  assert.equal(report.days[1].unique_visitors, 1);
  const stored = sql.exec('SELECT visitor_hash FROM public_app_page_views WHERE installation_id = ?', a).toArray();
  assert.equal(stored.some(row => row.visitor_hash === 'visitor-token-0001'), false);
  assert.equal(publicAppAnalytics(sql, b, { from: '2026-10-01', to: '2026-10-02' }).page_views, 1);
});

test('submissions count only persisted successful unique responses and follow the selected date range', () => {
  const sql = sqlite();
  const id = 'cccccccccccccccccccccccccccccccc';
  installPublicApp(sql, { installation_id: id, definition: originalDefinition, context: { kind: 'private', id: 'owner-c' }, installed_by: 'owner-c' });
  const input = { installation_id: id, action_id: 'apply', fields: { email: 'ana@example.test' }, request_key: 'submission-2026-10-01-a' };
  const accepted = recordPublicAppVisitorAction(sql, input);
  const repeated = recordPublicAppVisitorAction(sql, input);
  assert.equal(accepted.already_received, false);
  assert.equal(repeated.already_received, true);
  const report = publicAppAnalytics(sql, id, { from: accepted.received_at.slice(0, 10), to: accepted.received_at.slice(0, 10), submissions: [{ record_id: accepted.record_id, received_at: accepted.received_at }] });
  assert.equal(report.submissions, 1);
  assert.equal(report.days[0].submissions, 1);
  assert.equal(publicAppAnalytics(sql, id, { from: '2000-01-01', to: '2000-01-01' }).submissions, 0);
});

test('action definition updates compare and swap against the current installation definition', () => {
  const sql = sqlite();
  const id = 'dddddddddddddddddddddddddddddddd';
  installPublicApp(sql, { installation_id: id, definition: originalDefinition, context: { kind: 'private', id: 'owner-d' }, installed_by: 'owner-d' });
  const updated = updatePublicAppInstallationDefinition(sql, { installation_id: id, expected_definition: originalDefinition, definition: changedDefinition });
  assert.deepEqual(updated.definition, changedDefinition);
  assert.throws(() => updatePublicAppInstallationDefinition(sql, { installation_id: id, expected_definition: originalDefinition, definition: originalDefinition }), /changed since you opened/);
  assert.deepEqual(updatePublicAppInstallationDefinition(sql, { installation_id: id, expected_definition: changedDefinition, definition: changedDefinition }).definition, changedDefinition);
  // The same write sent again after its answer was lost: already done, not a conflict.
  assert.deepEqual(updatePublicAppInstallationDefinition(sql, { installation_id: id, expected_definition: originalDefinition, definition: changedDefinition }).definition, changedDefinition);
});

test('page view inputs and reporting ranges reject paths or dates that could leak query data or expand without bound', () => {
  const sql = sqlite();
  const id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  installPublicApp(sql, { installation_id: id, definition: originalDefinition, context: { kind: 'private', id: 'owner-e' }, installed_by: 'owner-e' });
  const base = { installation_id: id, visitor_token: 'visitor-token-0001', view_id: 'page-view-00000001' };
  assert.throws(() => recordPublicAppPageView(sql, { ...base, page_path: '/?email=ana@example.test' }), /page path is invalid/);
  assert.throws(() => recordPublicAppPageView(sql, { ...base, page_path: '/../secret' }), /page path is invalid/);
  assert.throws(() => recordPublicAppPageView(sql, { ...base, page_path: '/', visitor_token: 'short' }), /visitor token is invalid/);
  assert.throws(() => publicAppAnalytics(sql, id, { from: '2026-02-30', to: '2026-03-01' }), /start date is invalid/);
  assert.throws(() => publicAppAnalytics(sql, id, { from: '2024-01-01', to: '2026-01-01' }), /one year or less/);
});

test('a private site counts its answers from its own records a page at a time, never every record of their kind', async () => {
  const { sqliteHost } = await import('../src/local-store.mjs');
  const { decisionStore } = await import('../src/decision-store.mjs');
  const { privateSiteOperations } = await import('../../keep-an-accounts-private-sites-and-what-their-visitors/src/private-sites.mjs');
  const host = sqliteHost(':memory:');
  const { eeaf } = decisionStore(host.sql);
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  for (const id of [a, b]) installPublicApp(host.sql, { installation_id: id, definition: originalDefinition, context: { kind: 'private', id: 'owner-a' }, installed_by: 'owner-a' });
  // More than one page (200) of one installation's answers, and another installation's answers of the same kind.
  const answer = (id, n) => {
    const recordId = `public-app:${id}:answer-${String(n).padStart(4, '0')}`;
    return { id: `record:studio-inquiry:${recordId}`, type: 'record:studio-inquiry',
      value: { email: `v${n}@example.com`, _public_app: { installation_id: id, action_id: 'apply', record_id: recordId, received_at: '2026-10-01T10:00:00.000Z' } } };
  };
  eeaf.write([...Array.from({ length: 205 }, (_, n) => answer(a, n)), ...Array.from({ length: 3 }, (_, n) => answer(b, n))], { actor: { by: 'test' } });
  const asked = [];
  const counted = new Proxy(eeaf, { get: (target, key) => (key === 'ids' ? (type, options) => { asked.push(options); return target.ids(type, options); } : target[key]) });
  const sites = privateSiteOperations({ sql: host.sql, eeaf: counted, transaction: host.transaction, ownerUserId: () => 'owner-a', bindOwner: () => {}, ownsUser: user => user === 'owner-a' });
  const report = sites.analytics(a, { from: '2026-10-01', to: '2026-10-01' });
  assert.equal(report.submissions, 205);
  assert.equal(asked.length, 2, 'two pages of one installation');
  assert.ok(asked.every(options => options.limit === 200 && options.prefix === `record:studio-inquiry:public-app:${a}:`));
  assert.equal(sites.analytics(b, { from: '2026-10-01', to: '2026-10-01' }).submissions, 3);
});
