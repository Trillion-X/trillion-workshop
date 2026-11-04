// tools/check-against-a-persons-rules-and-verdicts: whether every piece is covered (do-work/piece-sweep.mjs). The sweep
// test is old trillion's test/method-sources.test.mjs, moved one to one; its tests that read a person's real files are
// here tests over made-up rows, and tool:check-every-piece-is-covered runs on seeded made-up records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomsOf, pieceRows } from '../do-work/pieces.mjs';
import { coverage, coverageInRecords, sweepAtoms } from '../do-work/piece-sweep.mjs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the piece sweep reports a changed piece with its checks, a gone piece, a new piece with no check, an orphan check and a reason pointing nowhere', () => {
  const before = atomsOf('Alpha stays.\n\nBeta will change.\n\nGamma will go.\n');
  const recorded = Object.fromEntries(before.map(atom => [atom.key, { identity: atom.identity }]));
  recorded['Alpha stays.'].no_check = { reason: 'covered', covered_by: ['no-such-check'] };
  const after = atomsOf('Alpha stays.\n\nBeta will change now.\n\nDelta is new.\n');
  const citing = [{ id: 'b', source: { section: 'Beta will change.' } }, { id: 'g', source: { section: 'Gamma will go.' } }];
  const swept = sweepAtoms(recorded, after, citing, citing);
  // A short piece is keyed by all its words, so editing it reads as the old piece gone and a new one arriving.
  assert.deepEqual(swept.gone.map(item => item.checks), [['b'], ['g']]);
  assert.deepEqual(swept.uncovered.map(item => item.key), ['Beta will change now.', 'Delta is new.']);
  assert.deepEqual(swept.orphan_checks.map(item => item.check), ['b', 'g']);
  assert.deepEqual(swept.missing_covered_by, [{ key: 'Alpha stays.', check: 'no-such-check' }]);
  const sameLead = atomsOf('**Beta.** will change.\n');
  const sameLeadEdited = atomsOf('**Beta.** now says something else.\n');
  const swept2 = sweepAtoms({ Beta: { identity: sameLead[0].identity } }, sameLeadEdited, [{ id: 'b', source: { section: 'Beta' } }], []);
  assert.deepEqual(swept2.changed.map(item => item.checks), [['b']]);
});

// Made-up rows in place of a person's real files: one piece checked, one with a reason, one uncovered, one shared by two files.
function madeUpPieces() {
  const pieces = pieceRows([
    { text: '## Made-up\n\n**Checked.** A made-up rule.\n\n**Reasoned.** A made-up aside.\n\nShared made-up words.\n', file: 'one.md' },
    { text: '## Other\n\nShared made-up words.\n\n**Open.** Nothing covers this.\n', file: 'two.md' },
  ]);
  const by = says => pieces.find(piece => piece.says === says);
  by('Checked').checked_by = ['made-up-check'];
  by('Reasoned').no_check = { reason: 'Said by the made-up check already.', covered_by: ['made-up-check'] };
  by('Shared made-up words.').checked_by = ['made-up-check'];
  return { pieces, by };
}

test('every piece of every file has a check or a recorded reason: counted per file, and an uncovered piece is refused by name', () => {
  const { pieces, by } = madeUpPieces();
  const report = coverage(pieces, [{ id: 'made-up-check' }]);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.files.map(({ file, pieces: count, with_check, with_reason }) => [file, count, with_check, with_reason]), [['one.md', 3, 2, 1], ['two.md', 2, 1, 0]]);
  assert.deepEqual(report.files[1].uncovered, [{ id: by('Open').id, section: 'Other / Open', says: 'Open' }]);
  assert.ok(report.lines.some(line => line.includes(by('Open').id) && line.includes('two.md')));
  by('Open').no_check = { reason: 'A made-up heading note, not a rule.' };
  assert.equal(coverage(pieces, [{ id: 'made-up-check' }]).status, 'passed');
});

test('a check or a covered_by naming a row that does not exist covers nothing, and is named', () => {
  const { pieces, by } = madeUpPieces();
  by('Open').no_check = { reason: 'Made-up.' };
  const report = coverage(pieces, []);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.missing_checks.map(item => item.check), ['made-up-check', 'made-up-check']);
  assert.deepEqual(report.missing_covered_by, [{ piece: by('Reasoned').id, check: 'made-up-check' }]);
  assert.deepEqual(report.files.flatMap(file => file.uncovered.map(item => item.says)).sort(), ['Checked', 'Reasoned', 'Shared made-up words.', 'Shared made-up words.']);
  assert.deepEqual(report.missing_count, { checks: 2, covered_by: 1 });
  by('Open').no_check = { reason: '   ' };
  assert.ok(coverage(pieces, [{ id: 'made-up-check' }]).files[1].uncovered.some(item => item.says === 'Open'), 'a blank reason is no reason');
});

test('the coverage of the records pages the ids of the Checks list, then the piece rows narrowed to what it reads, and writes nothing', async () => {
  const { pieces } = madeUpPieces();
  const records = [...pieces.map(value => ({ id: `record:check:${value.id}`, type: 'record:check', value })),
    { id: 'record:check:made-up-check', type: 'record:check', value: { id: 'made-up-check', method: 'made-up-base', words: ['made-up'] } }];
  const calls = [];
  const door = {
    async read() { throw new Error('the coverage reads no record one by one'); },
    async *list(query) {
      calls.push({ op: 'list', ...query });
      for (const record of records) {
        if (record.type !== query.type || (query.where && record.value.kind !== query.where.kind)) continue;
        yield query.fields?.length === 0 ? { id: record.id, type: record.type } : { id: record.id, type: record.type, value: Object.fromEntries(query.fields.filter(name => name in record.value).map(name => [name, record.value[name]])) };
      }
    },
    write() { throw new Error('the coverage writes nothing'); },
  };
  const report = await coverageInRecords(door);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.totals, { files: 2, pieces: 5, with_check: 3, with_reason: 1, uncovered: 1 });
  assert.deepEqual(calls, [{ op: 'list', type: 'record:check', fields: [] },
    { op: 'list', type: 'record:check', where: { kind: 'piece' }, fields: ['kind', 'checked_by', 'no_check', 'sources', 'says', 'key'] }]);
  await assert.rejects(coverageInRecords({ async read() { return null; }, async *list() {} }), /no piece rows/);
});

test('an answer too large for one door message comes in pages: every file once over the pages, every uncovered piece of one file once', () => {
  const pieces = Array.from({ length: 300 }, (_, at) => ({ id: `piece-${String(at).padStart(24, '0')}`, kind: 'piece', says: `Made-up ${at}`, checked_by: at % 3 ? [] : ['made-up-check'],
    sources: [{ file: `made-up-${String(at % 60).padStart(2, '0')}.md`, section: `Made-up / Made-up ${at}` }] }));
  const whole = coverage(pieces, [{ id: 'made-up-check' }]);
  assert.deepEqual(whole.totals, { files: 60, pieces: 300, with_check: 100, with_reason: 0, uncovered: 200 });
  const seen = [];
  for (let after = null, pages = 0; ; pages += 1) {
    const page = coverage(pieces, [{ id: 'made-up-check' }], { most_bytes: 3000, after, named: 3 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 3000, `page ${pages} is ${Buffer.byteLength(JSON.stringify(page))} bytes`);
    assert.deepEqual(page.totals, whole.totals);
    seen.push(...page.files.map(file => file.file));
    if (page.next === null) break;
    after = page.next;
  }
  assert.deepEqual(seen, [...new Set(pieces.map(piece => piece.sources[0].file))].sort());
  assert.notEqual(whole.next, null, 'naming every uncovered piece does not fit one answer, so even the default answer is a first page');
  const one = 'made-up-01.md', named = [];
  for (let after = null; ;) {
    const page = coverage(pieces, [{ id: 'made-up-check' }], { file: one, after, most_bytes: 2000, named: 2 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2000);
    named.push(...page.files[0].uncovered.map(piece => piece.id));
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(named.length, pieces.filter(piece => piece.sources[0].file === one && !piece.checked_by.length).length);
  assert.equal(new Set(named).size, named.length);
  assert.throws(() => coverage(pieces, [], { file: 'no-such.md' }), /No piece row names the file no-such.md/);
});

test('tool:check-every-piece-is-covered may only list check rows, and answers its seeded sample', async () => {
  const row = rows.find(item => item.id === 'tool:check-every-piece-is-covered');
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'record:check', operations: ['records:list'] }]);
  const sample = row.verify.find(item => item.records);
  const ran = await runRow(row, sample.input, { records: sample.records });
  assert.equal(ran.code, 0, ran.stderr ?? ran.stdout);
  const result = JSON.parse(ran.stdout.trim().split('\n').at(-1)).result;
  assert.equal(result.status, 'failed');
  assert.equal(result.files[0].uncovered.length, 1);
});
