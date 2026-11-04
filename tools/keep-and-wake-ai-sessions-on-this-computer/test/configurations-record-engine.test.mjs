// These are real SQLite record-engine integrations. The adapter matches the
// Durable Object SQL cursor and transaction contract used by local-store.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openRecords } from '../src/record-engine.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { makeConfigurations } from '../src/configurations.mjs';
import { makeLists } from '../src/lists.mjs';
import { yourRecordsStore } from '../src/your-records.mjs';

function host() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const statements = new Map();
  const sql = {exec(query, ...params) {
    assert.ok(params.length <= 100, 'match the Durable Object SQL bind limit');
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    const rows = statements.get(query).all(...params.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    return {toArray: () => rows, one: () => {assert.equal(rows.length, 1); return rows[0];}, [Symbol.iterator]: () => rows[Symbol.iterator]()};
  }};
  let depth = 0;
  const transaction = work => {
    if (depth) return work();
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {const result = work(); db.exec('COMMIT'); return result;}
    catch (error) {db.exec('ROLLBACK'); throw error;}
    finally {depth--;}
  };
  return {db, sql, transaction};
}
const hash = text => createHash('sha256').update(text).digest('hex');
const openStrict = held => {
  const before = process.env.RECORD_MODEL_STRICT;
  process.env.RECORD_MODEL_STRICT = '1';
  try {return openRecords(held.sql, {transaction: held.transaction, hash});}
  finally {if (before === undefined) delete process.env.RECORD_MODEL_STRICT; else process.env.RECORD_MODEL_STRICT = before;}
};
function fixture(t, engine) {
  const held = host();
  t.after(() => held.db.close());
  if (engine === 'eeaf') {
    const earlier = eeafStore(held.sql, {transaction: held.transaction, hash});
    earlier.write([{id: 'list:earlier', type: 'list', value: {label: 'Earlier list', row_type: 'earlier', fields: [{id: 'title', label: 'Title', kind: 'text'}], title_field: 'title'}}]);
  }
  const eeaf = openStrict(held);
  assert.equal(eeaf.engine(), engine);
  const lists = makeLists({eeaf});
  lists.save({id: 'accounts', label: 'Accounts', row_type: 'accounts', fields: [{id: 'title', label: 'Name', kind: 'text'}, {id: 'owner', label: 'Owner', kind: 'text'}]});
  const configurationOwner = scope => makeConfigurations({
    eeaf, ...scope,
    owner: () => ({id: 'relay-real', name: 'Sam Example'}),
    fieldsForTarget: target => target.startsWith('list:') ? (scope?.eeaf ?? eeaf).read(target)?.fields.map(field => field.id) ?? [] : null,
  });
  return {held, eeaf, lists, configurations: configurationOwner(), configurationOwner};
}
const definition = (id, extra = {}) => ({id, label: `Configuration ${id}`, target: 'list:accounts',
  field_ids: ['title', 'owner'], aspects: ['search'], settings: {search: 'Caroline'}, ...extra});

for (const engine of ['record-log', 'eeaf']) {
  test(`list write versions follow immutable history across sealing and rollback on ${engine}`, t => {
    const {held,eeaf,lists}=fixture(t,engine);
    const before=lists.version();
    const first=lists.putRows('accounts',{rows:[{id:'versioned',values:{title:'First'}}]});
    const version=first.write_set.version;
    assert.equal(typeof version,'string','a store with immutable history supplies its actual position');
    assert.ok(version>before,'the committed row advances history');
    assert.equal(lists.version(),version);
    assert.ok(eeaf.sealLog(),'the active immutable log is sealed');
    assert.equal(eeaf.lastLogId(),version,'sealing does not erase or change the newest position');
    assert.equal(openStrict(held).lastLogId(),version,'a cold engine reads that same sealed position');
    assert.throws(()=>held.transaction(()=>{
      eeaf.write([{id:'record:accounts:rolled-back-version',type:'record:accounts',value:{title:'Never committed'}}]);
      throw new Error('version rollback');
    }),/version rollback/);
    eeaf.forgetCached();
    assert.equal(eeaf.lastLogId(),version,'an aborted write does not advance the version');
    const next=lists.putRows('accounts',{rows:[{id:'versioned',values:{title:'Next'}}]});
    assert.ok(next.write_set.version>version,'the next committed write advances beyond the sealed log');
  });

  test(`configuration create, target-index cursors, exact reads and removals use the real ${engine} engine`, t => {
    const {held, eeaf, configurations: c, lists} = fixture(t, engine);
    for (let n = 0; n < 8; n++) c.save(definition(`c${n}`, n % 2 ? {target: 'screen:connections', open_path: '/connections'} : {}));
    assert.equal(eeaf.typeOf('record:configuration:c0'), 'record:configuration');
    assert.equal(eeaf.indexReady('record:configuration', 'target'), true);
    let before;
    const ids = [];
    do {
      const page = c.list({target: 'list:accounts', limit: 2, before});
      ids.push(...page.configurations.map(row => row.id)); before = page.next_before;
    } while (before);
    assert.deepEqual(ids, ['record:configuration:c6', 'record:configuration:c4', 'record:configuration:c2', 'record:configuration:c0']);
    assert.equal(c.get('c0').label, 'Configuration c0');
    assert.equal(lists.read('saved-configurations').rows.length, 8);
    const edited = c.save({id: 'c0', expected_revision: 1, label: 'Edited', target: 'screen:connections', open_path: '/connections'});
    assert.equal(edited.revision, 2);
    assert.ok(!c.list({target: 'list:accounts'}).configurations.some(row => row.id === edited.id));
    assert.ok(c.list({target: 'screen:connections'}).configurations.some(row => row.id === edited.id));
    if (engine === 'record-log') {
      assert.ok(eeaf.partsOf(edited.id).parts.some(part => part.role === 'target' && part.id === 'screen:connections'));
      eeaf.logStore().checkpoint();
    }
    const reopened = makeConfigurations({eeaf: openStrict(held)});
    assert.equal(reopened.get('c0').revision, 2);
    assert.ok(reopened.list({target: 'screen:connections'}).configurations.some(row => row.id === edited.id));
    assert.throws(() => reopened.remove('c0', 1), error => error.status === 409);
    reopened.remove('c0', 2);
    assert.equal(reopened.get('c0'), null);
    assert.ok(!reopened.list({target: 'screen:connections'}).configurations.some(row => row.id === edited.id));
  });

  test(`Lists and Workshop edits share revision and atomicity on the real ${engine} engine`, t => {
    const {eeaf, lists, configurations: c, configurationOwner} = fixture(t, engine);
    c.save(definition('c1'));
    const renamed = lists.putRows('saved-configurations', {rows: [{id: 'c1', expected_revision: 1, values: {label: 'Renamed in Lists'}}]});
    assert.equal(renamed.kept[0].values.revision, 2);
    assert.equal(c.get('c1').revision, 2);
    assert.equal(c.get('c1').label, 'Renamed in Lists');
    assert.throws(() => c.save({id: 'c1', expected_revision: 1, label: 'Old editor'}), error => error.status === 409);
    assert.throws(() => lists.putRows('saved-configurations', {rows: [{id: 'c1', values: {owner_name: 'Spoofed'}}]}), /original screen/);
    const records = yourRecordsStore(eeaf, {configurationOwner});
    assert.throws(() => records.write([
      {type: 'accounts', id: 'new', value: {title: 'Must not persist'}},
      {type: 'configuration', id: 'c1', value: {label: 'Stale tool', expected_revision: 1}},
    ]), error => error.status === 409);
    assert.equal(eeaf.read('record:accounts:new'), null);
    records.write([
      {type: 'accounts', id: 'new', value: {title: 'Persist together'}},
      {type: 'configuration', id: 'c1', value: {label: 'Edited by tool', expected_revision: 2, owner: {id: 'spoof'}}},
    ], {tool_id: 'tool:accounts'});
    assert.equal(eeaf.read('record:accounts:new').title, 'Persist together');
    assert.equal(c.get('c1').revision, 3);
    assert.deepEqual(c.get('c1').owner, {id: 'relay-real', name: 'Sam Example'});
    lists.putRows('saved-configurations', {remove: ['c1']});
    assert.equal(c.get('c1'), null);
    assert.deepEqual(c.list({target: 'list:accounts'}).configurations, []);
  });

  test(`managed list rename and Notes addition preserve navigation and field admission on ${engine}`, t => {
    const {lists, configurations: c} = fixture(t, engine);
    c.save(definition('c1'));
    const original = lists.read('saved-configurations').list;
    lists.save({id: original.id, label: 'My saved configurations'});
    const renamed = lists.read('saved-configurations').list;
    assert.deepEqual(renamed.managed_rows, {open_field: 'open_path', create_on_screen: true, share_record: true});
    lists.save({id: renamed.id, fields: [...renamed.fields, {id: 'notes', label: 'Notes', kind: 'long-text'}]});
    const withNotes = lists.read('saved-configurations').list;
    assert.deepEqual(withNotes.managed_rows, original.managed_rows);
    assert.ok(withNotes.fields.some(field => field.id === 'notes'));
    for (const id of ['target', 'owner_name', 'aspects', 'updated_at', 'open_path']) {
      assert.equal(withNotes.fields.find(field => field.id === id).editable, false);
    }
    assert.match(c.get('c1').open_path, /configuration=record%3Aconfiguration%3Ac1/);
  });
}

test('strict configuration model survives a colliding user summary list without rewriting it', t => {
  const {eeaf, lists, configurations: c} = fixture(t, 'record-log');
  lists.save({id: 'saved-configurations', label: 'My unrelated list', row_type: 'unrelated'});
  c.save(definition('c1'));
  assert.equal(eeaf.read('list:saved-configurations').row_type, 'unrelated');
  assert.equal(c.get('c1').revision, 1);
  assert.equal(c.list({target: 'list:accounts'}).configurations.length, 1);
});
