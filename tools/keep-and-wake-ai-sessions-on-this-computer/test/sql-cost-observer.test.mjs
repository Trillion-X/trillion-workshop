import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlCostObserver, sqlTemplateFingerprint, watchedSql } from '../src/live-screen.mjs';

const clock = () => { let at = 0; return { now: () => at, tick: ms => { at += ms; } }; };

test('costly synchronous SQL reports bounded windows even when the Worker clock does not advance', () => {
  const reports = [];
  const observe = sqlCostObserver(report => reports.push(report), () => 0);
  for (let index = 0; index < 8192; index += 1) {
    observe("SELECT value FROM records WHERE owner = 'private-owner'", { rowsRead: 30, rowsWritten: 0 });
  }
  assert.equal(reports.length, 2, 'a CPU-limited event need not survive a clock minute to name its SQL');
  for (const report of reports) {
    assert.equal(report.seconds, 0);
    assert.equal(report.statements, 4096);
    assert.equal(report.rows_read, 4096 * 30);
    assert.ok(report.top.length <= 8);
  }
  assert.doesNotMatch(JSON.stringify(reports), /private-owner|records/);
});

test('frozen-clock cheap statement windows stay quiet and later costly consumption is counted once', () => {
  const reports = [];
  const observe = sqlCostObserver(report => reports.push(report), () => 0);
  for (let index = 0; index < 4096; index += 1) observe('SELECT 1', { rowsRead: 0, rowsWritten: 0 });
  assert.deepEqual(reports, []);
  const cursor = { rowsRead: 0, rowsWritten: 0 };
  observe('SELECT value FROM held', cursor);
  cursor.rowsRead = 200_000;
  for (let index = 0; index < 20; index += 1) observe('SELECT value FROM held', cursor);
  for (let index = 0; index < 4095; index += 1) observe('SELECT 1', { rowsRead: 0, rowsWritten: 0 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].statements, 4097, 'quiet history is retained; cursor observations are not new statements');
  assert.equal(reports[0].rows_read, 200_000);
});

test('sub-threshold statement windows accumulate instead of discarding an expensive frozen-clock minute', () => {
  const reports = [];
  const observe = sqlCostObserver(report => reports.push(report), () => 0);
  for (let index = 0; index < 4166; index += 1) observe('SELECT value FROM held', { rowsRead: 24, rowsWritten: 0 });
  assert.equal(reports.length, 0);
  observe('SELECT value FROM held', { rowsRead: 24, rowsWritten: 0 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].statements, 4167);
  assert.equal(reports[0].rows_read, 100_008);
});

test('lazy cursor consumption crossing an early report remains a once-counted delta in the next report', () => {
  const reports = [];
  const time = clock();
  const observe = sqlCostObserver(report => reports.push(report), time.now);
  for (let index = 0; index < 4095; index += 1) observe('SELECT value FROM held', { rowsRead: 30, rowsWritten: 0 });
  const cursor = { rowsRead: 0, rowsWritten: 0 };
  observe('SELECT value FROM lazy', cursor);
  assert.equal(reports.length, 1);
  cursor.rowsRead = 200_000;
  for (let index = 0; index < 20; index += 1) observe('SELECT value FROM lazy', cursor);
  time.tick(60_000);
  observe('SELECT 1', { rowsRead: 0, rowsWritten: 0 });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].rows_read, 4095 * 30);
  assert.equal(reports[1].rows_read, 200_000);
  assert.equal(reports[1].statements, 1);
});

test('each template\'s billed rows add up over a minute, many small statements included, and no value or name is logged', () => {
  const reports = [];
  const time = clock();
  let writesNoticed = 0;
  const sql = watchedSql({
    exec(query) {
      if (query.startsWith('DELETE')) return { rowsRead: 2, rowsWritten: 900 };
      return { rowsRead: 0, rowsWritten: 0, toArray() { this.rowsRead = 1_500; return [{ id: 1 }]; } };
    },
  }, () => { writesNoticed += 1; }, sqlCostObserver(report => reports.push(report), time.now));

  const query = "SELECT id FROM messages WHERE email = 'private@example.com' AND id = ?";
  for (let index = 0; index < 100; index += 1) assert.deepEqual(sql.exec(query, 'private-bound-value').toArray(), [{ id: 1 }]);
  for (let index = 0; index < 10; index += 1) sql.exec('DELETE FROM messages WHERE id = ?', 'private-bound-value');
  assert.equal(writesNoticed, 10);
  assert.equal(reports.length, 0, 'nothing is said inside the minute');
  time.tick(60_000);
  sql.exec(query, 'x').toArray();
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.equal(report.rows_read, 100 * 1_500 + 10 * 2);
  assert.equal(report.rows_written, 9_000);
  // 9 000 rows written are billed as 9 million rows read, so the delete outranks 150 000 rows read.
  assert.deepEqual(report.top.map(row => [row.operation, row.statements, row.rows_read]), [['delete', 10, 20], ['select', 101, 150_000]]);
  assert.equal(report.top[1].query_template, sqlTemplateFingerprint(query));
  assert.equal(sqlTemplateFingerprint(query), sqlTemplateFingerprint("SELECT id FROM messages WHERE email = 'another@example.com' AND id = ?"));
  assert.doesNotMatch(JSON.stringify(reports), /private|messages|bound-value/i);
});

test('a quiet minute says nothing, and the next window starts empty', () => {
  const reports = [];
  const time = clock();
  const observe = sqlCostObserver(report => reports.push(report), time.now);
  observe('SELECT value FROM a WHERE id = ?', { rowsRead: 50, rowsWritten: 0 });
  time.tick(61_000);
  observe('SELECT value FROM a WHERE id = ?', { rowsRead: 50, rowsWritten: 0 });
  assert.equal(reports.length, 0);
  observe('SELECT value FROM b', { rowsRead: 200_000, rowsWritten: 0 });
  time.tick(61_000);
  observe('SELECT value FROM a WHERE id = ?', { rowsRead: 1, rowsWritten: 0 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].rows_read, 200_001);
});

test('a cursor keeps the shape it had: missing methods stay missing and a plain iterable still iterates', () => {
  const reports = [];
  const time = clock();
  const sql = watchedSql({ exec() {
    const rows = [{ id: 1 }, { id: 2 }];
    return { rowsRead: 70_000, rowsWritten: 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } }, () => {}, sqlCostObserver(report => reports.push(report), time.now));
  const cursor = sql.exec('SELECT id FROM plain');
  assert.equal(typeof cursor.one, 'undefined');
  assert.equal(typeof cursor.toArray, 'undefined');
  assert.equal(typeof cursor.raw, 'undefined');
  assert.deepEqual([...cursor], [{ id: 1 }, { id: 2 }]);
  time.tick(60_000);
  sql.exec('SELECT id FROM plain');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].top[0].rows_read, 140_000);
});

test('iteration and raw cursor consumption count each cursor\'s final billed reads once', () => {
  const reports = [];
  const time = clock();
  let cursor;
  const sql = watchedSql({ exec() {
    cursor = {
      rowsRead: 0, rowsWritten: 0,
      next() { this.rowsRead += 60_000; return { done: this.rowsRead >= 120_000 }; },
      raw() { return { toArray: () => { this.rowsRead = 20_002; return [[1]]; } }; },
    };
    return cursor;
  } }, () => {}, sqlCostObserver(report => reports.push(report), time.now));
  for (const row of sql.exec('SELECT value FROM first')) void row;
  assert.deepEqual(sql.exec('SELECT value FROM second').raw().toArray(), [[1]]);
  time.tick(60_000);
  sql.exec('SELECT value FROM third').raw().toArray();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].top.map(row => row.rows_read), [120_000, 20_002, 0]);
});

test('each costly template names the functions that ran it, never a value', () => {
  const reports = [];
  const time = clock();
  const sql = watchedSql({ exec: () => ({ rowsRead: 0, rowsWritten: 0, toArray() { this.rowsRead = 60_000; return []; } }) }, () => {}, sqlCostObserver(report => reports.push(report), time.now));
  function readTheWholeRecord(id) { return sql.exec('SELECT * FROM entity WHERE id = ?', id).toArray(); }
  function answerTheScreen() { return readTheWholeRecord('private-id'); }
  answerTheScreen();
  answerTheScreen();
  time.tick(60_000);
  sql.exec('SELECT 1').toArray();
  const [{ top: [costly] }] = reports;
  assert.deepEqual(Object.keys(costly.callers).map(chain => chain.split(' < ').slice(0, 2)), [['readTheWholeRecord', 'answerTheScreen']]);
  assert.doesNotMatch(JSON.stringify(reports), /private-id/);
});
