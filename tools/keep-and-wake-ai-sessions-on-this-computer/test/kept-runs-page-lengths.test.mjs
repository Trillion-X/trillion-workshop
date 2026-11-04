import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

function fixture(t, prefix, options = {}) {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix,
    cache_bytes: 0, page_bytes: 16 * 1024, ...options });
  const pages = () => [...host.sql.exec(`SELECT run FROM ${prefix}_runs`)].flatMap(({ run }) =>
    [...host.sql.exec(`SELECT page, body FROM ${prefix}_run_${run} WHERE page >= 0 ORDER BY page`)]
      .map(row => ({ ...row, table: `${prefix}_run_${run}` })));
  const replace = (page, body) => host.sql.exec(`UPDATE ${page.table} SET body = ? WHERE page = ?`, body, page.page);
  return { host, open, pages, replace };
}
// A page's header line is `~` + the JSON of its offsets and bigs, HEAD_SEP, then its keys' suffixes (kept as they are).
const split = body => {
  const end = body.indexOf('\n');
  const sep = body.indexOf('\u0002');
  return { head: JSON.parse(body.slice(1, sep)), section: body.slice(sep + 1, end), tail: body.slice(end + 1) };
};
const join = ({ head, section, tail }) => `~${JSON.stringify(head)}\u0002${section}\n${tail}`;
const positions = lengths => {
  const offsets = [0];
  for (const length of lengths) offsets.push(offsets.at(-1) + length);
  return offsets;
};

test('value lengths reduce stored page headers while cold exact and ordered reads keep every Unicode value', t => {
  const f = fixture(t, 'lengths');
  let space = f.open();
  const expected = Array.from({ length: 400 }, (_, index) => [
    `共同😀:${String(index).padStart(4, '0')}`,
    { shared: 'same 😀 prefix', index, text: `${index % 7}λ`.repeat(11 + index % 17) },
  ]);
  for (const [key, value] of expected) space.put(key, value);
  space.flush();
  let saved = 0, compact = 0;
  for (const page of f.pages()) {
    const { head } = split(page.body);
    if (!head.d) continue;
    compact += 1;
    const { d, ...rest } = head;
    const legacy = JSON.stringify({ ...rest, o: positions(d) });
    const current = JSON.stringify(head);
    assert.ok(current.length < legacy.length, 'the writer chooses lengths only when the complete header is smaller');
    saved += legacy.length - current.length;
    assert.ok(page.body.length <= space.settings.page_bytes, 'the existing page size remains bounded');
  }
  assert.ok(compact > 0, 'at least one real SQLite page uses compact lengths');
  assert.ok(saved > 0, 'the same values take fewer stored header characters');
  space = f.open();
  for (const [key, value] of expected) assert.deepEqual(space.get(key), value);
  assert.deepEqual(space.range(expected[0][0], `${expected.at(-1)[0]}\uffff`), expected);
  assert.deepEqual(space.range(expected[0][0], `${expected.at(-1)[0]}\uffff`, { reverse: true }), [...expected].reverse());
});

test('legacy absolute offsets, list pages and uniform pages remain readable after a cold reopen', t => {
  for (const kind of ['offsets', 'list', 'uniform']) {
    const f = fixture(t, `legacy_${kind}`);
    const expected = Array.from({ length: 60 }, (_, index) => [`k${String(index).padStart(3, '0')}`,
      kind === 'uniform' ? { text: 'same 😀' } : { common: 'same', index, text: '😀'.repeat(1 + index % 7) }]);
    let space = f.open();
    for (const [key, value] of expected) space.put(key, value);
    space.flush();
    const pages = f.pages();
    assert.equal(pages.length, 1);
    if (kind === 'offsets') {
      const { head, section, tail } = split(pages[0].body);
      const { d, ...rest } = head;
      assert.ok(d);
      f.replace(pages[0], join({ head: { ...rest, o: positions(d) }, section, tail }));
    } else if (kind === 'list') f.replace(pages[0], JSON.stringify(expected));
    else assert.ok(split(pages[0].body).head.v);
    space = f.open();
    assert.deepEqual(space.range('k', 'l', { keys_only: true }), expected.map(([key]) => [key, undefined]));
    assert.deepEqual(space.ranges([{ lo: 'k', hi: 'l' }], { keys_only: true }), expected.map(([key]) => [key, undefined]));
    assert.deepEqual(space.ranges([{ lo: 'k', hi: 'l' }], { keys_only: true, limit_per_range: 3 }), expected.slice(0, 3).map(([key]) => [key, undefined]));
    assert.deepEqual(space.range('k', 'l'), expected);
    for (const [key, value] of expected) assert.deepEqual(space.get(key), value);
  }
});

test('compact lengths preserve tombstones and separately kept large values through bounded cold merges', t => {
  const f = fixture(t, 'mixed', { page_bytes: 4096, big_bytes: 512, fan_in: 2, max_runs: 2 });
  let space = f.open();
  for (let run = 0; run < 3; run += 1) {
    for (let index = 0; index < 80; index += 1) space.put(`k${String(index).padStart(3, '0')}`, { index, run, text: '😀'.repeat(7 + index % 11) });
    space.put('large', { run, text: 'λ😀'.repeat(700) });
    space.remove('k017');
    space.flush();
  }
  assert.ok(f.pages().some(page => split(page.body).head.d?.some(length => length === 0)), 'tombstone or large reference has no inline value characters');
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 100, 'bounded resumable merge completes');
    space.step({ max_pages: 1 });
    space = f.open();
  }
  assert.equal(space.get('k017'), undefined);
  assert.deepEqual(space.get('large'), { run: 2, text: 'λ😀'.repeat(700) });
  for (let index = 0; index < 80; index += 1) if (index !== 17)
    assert.deepEqual(space.get(`k${String(index).padStart(3, '0')}`), { index, run: 2, text: '😀'.repeat(7 + index % 11) });
});

test('invalid value lengths fail before a selected value is returned', t => {
  for (const [caseIndex, corrupt] of [d => d.slice(1), d => [-1, ...d.slice(1)], d => [0.5, ...d.slice(1)], d => [d[0] + 1, ...d.slice(1)]].entries()) {
    const f = fixture(t, `broken_${caseIndex}`);
    let space = f.open();
    for (let index = 0; index < 50; index += 1) space.put(`k${String(index).padStart(3, '0')}`, { index, text: 'abcd'.repeat(10 + index % 3) });
    space.flush();
    const page = f.pages()[0];
    const { head, section, tail } = split(page.body);
    assert.ok(head.d);
    f.replace(page, join({ head: { ...head, d: corrupt(head.d) }, section, tail }));
    space = f.open();
    assert.throws(() => space.range('k', 'l', { keys_only: true }), /invalid value lengths/);
    assert.throws(() => space.ranges([{ lo: 'k', hi: 'l' }], { keys_only: true }), /invalid value lengths/);
    assert.throws(() => space.ranges([{ lo: 'k', hi: 'l' }], { keys_only: true, limit_per_range: 3 }), /invalid value lengths/);
    assert.throws(() => space.get('k000'), /invalid value lengths/);
  }
});

test('key-only pages return real metadata and upgrade safely for every value-reading cursor', t => {
  const f = fixture(t, 'heads', { page_bytes: 8192, big_bytes: 2048, cache_bytes: 64 * 1024,
    max_runs: 100, fan_in: 100 });
  const returned = [], exec = f.host.sql.exec.bind(f.host.sql);
  f.host.sql.exec = (query, ...params) => {
    const cursor = exec(query, ...params);
    for (const row of cursor.toArray()) if (typeof row.body === 'string') returned.push({ query, body: row.body, tailChars: row.tail_chars });
    return cursor;
  };
  let space = f.open();
  const model = new Map();
  for (let index = 0; index < 180; index += 1) {
    const key = `${index % 2 ? '共同😀' : '共同\ue000'}:${String(index).padStart(3, '0')}`;
    const value = { index, text: 'x'.repeat(512 + index % 13) };
    space.put(key, value); model.set(key, value);
  }
  const bigKey = '共同😀:big', bigValue = { text: 'kept separately'.repeat(800) };
  space.put(bigKey, bigValue); model.set(bigKey, bigValue);
  space.flush();
  const removed = [...model.keys()][17];
  space.remove(removed); model.delete(removed);
  const replaced = [...model.keys()][35], replacement = { text: 'current value' };
  space.put(replaced, replacement); model.set(replaced, replacement);
  space.flush();
  const storedBytes = f.pages().reduce((bytes, page) => bytes + Buffer.byteLength(page.body), 0);
  space = f.open(); returned.length = 0;
  const expected = [...model].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(space.range('共同', '共名', { keys_only: true }), expected.map(([key]) => [key, undefined]));
  assert.ok(returned.length > 2, 'the real cursor crosses multiple stored pages and runs');
  assert.ok(returned.every(({ body, tailChars }) => body.endsWith('\n') && Number.isSafeInteger(tailChars)), 'only actual ASCII-tail headers crossed SQLite');
  assert.ok(returned.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0) < storedBytes / 4,
    'returned metadata excludes neighboring inline values');
  assert.ok(space.held().cache_bytes > 0 && space.held().cache_bytes <= space.settings.cache_bytes);
  for (const limit of [Infinity, 3]) {
    space = f.open(); returned.length = 0;
    const bounds = [{ lo: '共同', hi: '共名' }];
    const valueBudget = { remaining: 0 };
    const keys = expected.slice(0, limit).map(([key]) => [key, undefined]);
    assert.deepEqual(space.ranges(bounds, { keys_only: true, limit_per_range: limit, value_budget: valueBudget }), keys);
    assert.equal(valueBudget.remaining, 0, 'key-only batches never admit or charge value bodies');
    assert.ok(returned.every(({ body, tailChars }) => body.endsWith('\n') && Number.isSafeInteger(tailChars)), 'batch SQL returns metadata only');
    assert.ok(space.held().cache_bytes <= space.settings.cache_bytes);
    const reader = f.open().rangeReader();
    assert.deepEqual(reader.ranges(bounds, { keys_only: true, limit_per_range: limit, value_budget: { remaining: 0 } }), keys);
    reader.close();
  }
  space = f.open();
  assert.deepEqual(space.ranges([{ lo: '共同', hi: '共名' }], { keys_only: true,
    limit_per_range: 3, page_budget: { remaining: 100 }, entry_budget: { remaining: 100 } }), expected.slice(0, 3).map(([key]) => [key, undefined]));
  assert.throws(() => f.open().ranges([{ lo: '共同', hi: '共名' }], { keys_only: true,
    limit_per_range: 3, page_budget: { remaining: 0 } }), error => error.constructor.name === 'KeptRangeBudgetExceeded');
  assert.throws(() => f.open().ranges([{ lo: '共同', hi: '共名' }], { keys_only: true,
    limit_per_range: 3, entry_budget: { remaining: 0 } }), error => error.constructor.name === 'KeptRangeBudgetExceeded');
  space = f.open(); returned.length = 0;
  assert.deepEqual(space.range('共同', '共名', { keys_only: true }), expected.map(([key]) => [key, undefined]));
  returned.length = 0;
  assert.deepEqual(space.range('共同', '共名', { keys_only: true, reverse: true }), [...expected].reverse().map(([key]) => [key, undefined]));
  assert.equal(returned.length, 0, 'warm key-only reads reuse charged metadata');
  assert.equal(space.get(removed), undefined);
  assert.deepEqual(space.get(replaced), replacement);
  assert.deepEqual(space.get(bigKey), bigValue);
  const middle = expected[Math.floor(expected.length / 2)];
  assert.deepEqual(space.ranges([{ lo: middle[0], hi: middle[0] + '\u0000' }]), [middle]);
  assert.deepEqual(space.ranges([{ lo: '共同', hi: '共名' }], { limit_per_range: 3 }), expected.slice(0, 3));
  assert.deepEqual(space.ranges([{ lo: '共同', hi: '共名' }]), expected);
  assert.deepEqual([...space.walk('共同', '共名')], expected);
  assert.deepEqual(space.range('共同', '共名'), expected);
  assert.ok(space.held().cache_bytes <= space.settings.cache_bytes);
  space.remove(middle[0]); model.delete(middle[0]);
  space.flush(); space.reloadCatalog();
  assert.deepEqual(space.range('共同', '共名', { keys_only: true }), [...model.keys()].sort().map(key => [key, undefined]));
  assert.equal(space.get(middle[0]), undefined);
});

test('non-ASCII value tails retain full UTF-16 validation during key-only reads', t => {
  const f = fixture(t, 'heads_unicode', { cache_bytes: 4096 });
  let space = f.open();
  const expected = Array.from({ length: 50 }, (_, index) => [`k${String(index).padStart(3, '0')}`,
    { index, text: 'λ😀'.repeat(10 + index % 3) }]);
  for (const [key, value] of expected) space.put(key, value);
  space.flush();
  space = f.open();
  assert.deepEqual(space.range('k', 'l', { keys_only: true }), expected.map(([key]) => [key, undefined]));
  assert.deepEqual(space.range('k', 'l'), expected);
  const page = f.pages()[0], { head, section, tail } = split(page.body);
  assert.ok(head.d);
  f.replace(page, join({ head: { ...head, d: [head.d[0] + 1, ...head.d.slice(1)] }, section, tail }));
  assert.throws(() => f.open().range('k', 'l', { keys_only: true }), /invalid value lengths/);
});
