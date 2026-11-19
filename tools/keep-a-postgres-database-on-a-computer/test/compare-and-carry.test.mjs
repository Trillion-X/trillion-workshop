// tools/keep-a-postgres-database-on-a-computer/test/compare-and-carry.test.mjs
//
// A database moved under a new name loses nothing: proved on two in-memory PostgreSQL databases (PGlite) with made-up rows.
// The comparison finds a copy equal however its rows and json keys are ordered, and names what differs; the carry brings the
// rows and columns written to the old one after the copy, takes out what the old one's writer removed only when asked, and
// keeps the new one's rows when asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { compareTwoDatabases } from '../do-work/compare-two-databases.mjs';
import { carryRows } from '../do-work/carry-rows-to-new-database.mjs';

const SCHEMA = `
create table people (id text primary key, name text not null, facts json);
create sequence notes_id_seq;
create table notes (id bigint primary key default nextval('notes_id_seq'), person text references people(id), said text);
comment on table people is 'Who the site knows';
create function fold(t text) returns text language sql immutable as $$ select lower(t) $$;
create view loud as select id, upper(name) as name from people;`;

const open = async (sql, rows) => {
  const db = new PGlite();
  await db.exec(sql);
  await db.exec(rows);
  return { query: async (text, params = []) => (await db.query(text, params)).rows, db };
};

test('a copy with the same rows in another order, and json keys in another order, is equal', async () => {
  const first = await open(SCHEMA, `insert into people values ('a','Ann','{"x":1,"y":2}'),('b','Bo',null);
    insert into notes (person, said) values ('a','hi'),('b','yo');`);
  const second = await open(SCHEMA, `insert into people values ('b','Bo',null),('a','Ann','{"y":2,"x":1}');
    insert into notes (id, person, said) values (2,'b','yo'),(1,'a','hi'); select setval('notes_id_seq', 2);`);
  const result = await compareTwoDatabases(first, second);
  assert.deepEqual(result.objects.only_in_first, []);
  assert.deepEqual(result.objects.only_in_second, []);
  assert.equal(result.tables_differ, 0);
  assert.equal(result.tables_equal, 2);
});

test('a copy missing a row, a table, a column or a function is named, with counts and no values', async () => {
  const first = await open(SCHEMA, `insert into people values ('a','Ann',null),('b','Bo',null); create table extra (id int primary key);`);
  const second = await open(SCHEMA.replace(/create function[^;]*\$\$;/, ''), `insert into people values ('a','Ann',null); alter table people add column age int;`);
  const result = await compareTwoDatabases(first, second);
  const people = result.tables.find(t => t.table === 'people');
  assert.equal(people.equal, false);
  assert.equal(people.first, 2);
  assert.equal(people.second, 1);
  assert.deepEqual(result.tables.find(t => t.table === 'extra'), { table: 'extra', missing_in: 'second' });
  assert.ok(result.objects.only_in_first.some(x => x.startsWith('function ') && x.includes('fold')));
  assert.ok(result.objects.only_in_second.some(x => x.startsWith('column people.age ')));
  assert.ok(!JSON.stringify(result).includes('Bo'), 'no row value is in the answer');
});

test('the carry brings new columns, new rows, changed rows and sequences, and the copy is then equal', async () => {
  const old = await open(SCHEMA, `insert into people values ('a','Ann',null),('b','Bo',null); insert into notes (person, said) values ('a','hi');`);
  const copy = await open(SCHEMA, `insert into people values ('a','Ann',null),('b','Bo',null); insert into notes (person, said) values ('a','hi');`);
  // Written to the old one after the copy: a new column, a new row, a changed row, a removed row, a sequence moved on.
  await old.db.exec(`alter table people add column city text; insert into people values ('c','Cy',null,'Rome');
    update people set name = 'Anne' where id = 'a'; insert into notes (person, said) values ('c','new'), ('b','gone');
    delete from notes where said = 'gone';`);
  const report = await carryRows(old, copy, ['people', 'notes'], { deletes_too: true });
  assert.deepEqual(report.find(r => r.table === 'people').columns_added, ['city']);
  assert.ok(report.some(r => r.sequence === 'notes_id_seq' && r.to === '3'));
  const result = await compareTwoDatabases(old, copy);
  assert.equal(result.tables_differ, 0);
  assert.deepEqual(result.objects.only_in_first, []);
  assert.deepEqual(result.objects.only_in_second, []);
});

test('without deletes_too a row the old one removed stays; with keep_new a row both have keeps the new one', async () => {
  const old = await open(SCHEMA, `insert into people values ('a','Ann',null);`);
  const copy = await open(SCHEMA, `insert into people values ('a','Ann (new)',null),('z','Zed',null);`);
  await carryRows(old, copy, ['people'], { keep_new: true });
  assert.deepEqual((await copy.query(`select id, name from people order by id`)), [{ id: 'a', name: 'Ann (new)' }, { id: 'z', name: 'Zed' }]);
  await carryRows(old, copy, ['people']);
  assert.deepEqual((await copy.query(`select id, name from people order by id`)), [{ id: 'a', name: 'Ann' }, { id: 'z', name: 'Zed' }]);
  await assert.rejects(carryRows(old, copy, ['people'], { keep_new: true, deletes_too: true }), /do not go together/);
});

test('a failed carry leaves the new database as it was', async () => {
  const old = await open('create table loose (id int, said text);', `insert into loose values (1,'x');`);
  const copy = await open('create table loose (id int, said text);', '');
  await old.db.exec('alter table loose add column extra text');
  await assert.rejects(carryRows(old, copy, ['loose']), /no primary key/);
  assert.deepEqual((await copy.query(`select count(*)::int as n from information_schema.columns where table_name = 'loose'`)), [{ n: 2 }]);
});
