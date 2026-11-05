import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';

for (const [name, open] of [['record log', recordLogStore], ['decomposed store', eeafStore]]) {
  test(`linked removal visits later definition pages through bounded reads on the ${name}`, async t => {
    const host = sqliteHost(':memory:');
    t.after(() => host.db.close());
    const eeaf = open(host.sql, { transaction: host.transaction, hash: identityOf });
    const lists = makeLists({ eeaf });
    await lists.save({ id: 'target', label: 'Target', fields: [{ id: 'name', label: 'Name' }] });
    await lists.putRows('target', { rows: [{ id: 'gone', values: { name: 'Gone' } }] });
    for (let i = 0; i < 60; i += 1) await lists.save({ id: `unused-${i}`, label: `Unused ${i}` });
    await lists.save({ id: 'a-dependent', label: 'Dependent', fields: [
      { id: 'name', label: 'Name' },
      { id: 'target', label: 'Target', kind: 'link', links_to: 'target', on_target_remove: 'detach' },
    ] });
    await lists.putRows('a-dependent', { rows: [{ id: 'child', values: { name: 'Child', target: 'gone' } }] });
    const definitionPages = [];
    const bounded = makeLists({ eeaf: { ...eeaf, ids(type, options) {
      assert.ok(options?.limit > 0, 'removal never enumerates an entire record type');
      if (type === 'list') definitionPages.push(options);
      return eeaf.ids(type, options);
    } } });
    bounded.putRows('target', { remove: ['gone'] });
    assert.ok(definitionPages.length >= 2, 'a dependent beyond the first metadata page is visited');
    assert.ok(definitionPages[1].before, 'later metadata pages advance by exact record identity');
    assert.equal((await lists.row('a-dependent', 'child')).values.target, undefined);
    assert.equal(await lists.row('target', 'gone'), null);
  });
}
