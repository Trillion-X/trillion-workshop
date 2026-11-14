// A method is a saved view over the person's method rows, read a page at a time and answered for any number of its rows in
// one call (method-rows/view.mjs, method-rows/answers.mjs). Every name, row and answer here is made up. The door is the
// one the tool's row declares: a kind or an operation the row does not name is refused, as the engine refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAMethod } from '../method-rows/view.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { memoryDoor } from './fixtures.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const settings = JSON.parse(readFileSync(new URL('../method-rows/settings.json', import.meta.url), 'utf8'));
const VIEW = 'list-view:sample-methods:sample-method';
const ROW = name => `record:method-row:sample-methods~${name}`;
const DECISION = 'source:c2FtcGxlOm1ldGhvZC0x';

function granted(door, toolId) {
  const row = rows.find(each => each.id === toolId);
  const rights = new Map(row.invoke.records.rights.map(item => [item.kind, new Set(item.operations)]));
  const need = (kind, operation) => { if (!rights.get(kind)?.has(operation)) throw new Error(`${toolId} is not granted ${operation} on ${kind}`); };
  return {
    read: async (type, id) => { need(type, 'records:read'); return door.read(type, id); },
    async *list(input) { need(input.type, 'records:list'); yield* door.list(input); },
    write: async (list, options) => { for (const record of list) need(record.type, 'records:write'); return door.write(list, options); },
  };
}

const ruleOf = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
const group = (...list) => ({ kind: 'group', combinator: 'and', negate: false, rules: list });

// A list of made-up method rows: one file, three sections in a different order than their ids, and a row of another kind.
function account(extra = {}) {
  const door = memoryDoor();
  door.put('list:sample-methods', 'list', { row_type: 'method-row', fields: [{ id: 'title', kind: 'text' }, { id: 'kind', kind: 'text' }, { id: 'document.offset', kind: 'number' }, { id: 'note', kind: 'long-text' }] });
  door.put(VIEW, 'list-view', { list_id: 'sample-methods', view: { id: 'sample-method', label: 'A made-up method', rules: group(ruleOf('kind', 'is_text', { text: 'section' })), sort: [{ field: 'document.offset', direction: 'asc' }] }, ...extra.view });
  for (const [name, value] of Object.entries({
    file: { title: 'A made-up file', kind: 'file', 'document.offset': 0 },
    alpha: { title: 'Alpha section', kind: 'section', 'document.offset': 30 },
    beta: { title: 'Beta section', kind: 'section', 'document.offset': 10 },
    gamma: { title: 'Gamma section', kind: 'section', 'document.offset': 20, ...extra.gamma },
    ...extra.rows,
  })) door.put(ROW(name), 'record:method-row', value);
  door.put(DECISION, 'decision', { source_id: 'sample:method-1', input: { goal: 'Decide a made-up thing', evidence: [{ ref: 'e1', claim: 'A made-up fact' }, { ref: 'gone', claim: 'A retracted fact', retracted_at: '2026-11-14T00:00:00.000Z' }] } });
  door.put(`decision-evidence:${DECISION}:0001`, 'decision-evidence', { ref: 'e2', claim: 'A made-up fact laid beside the decision' });
  return door;
}

const read = (door, input) => readAMethod(input, { door: granted(door, 'tool:read-a-method') });
const record = (door, input) => recordMethodAnswers({ decision_id: DECISION, method: VIEW, ...input }, { door: granted(door, 'tool:record-method-answers') });

test('a method reads as the rows its view keeps, in its sort, each with the strictness it is checked by', async () => {
  const page = await read(account(), { method: VIEW });
  assert.deepEqual(page.rows.map(row => row.values.title), ['Beta section', 'Gamma section', 'Alpha section']);
  assert.equal(page.of, 3);
  assert.equal(page.next, null);
  assert.equal(page.label, 'A made-up method');
  assert.deepEqual(page.rows.map(row => row.strictness.from), ['default', 'default', 'default']);
  assert.deepEqual(page.rows[0].strictness.rules, settings.strictness.default.rules);
});

test('a row\'s own strictness wins over the method\'s, and the method\'s over the default', async () => {
  const own = group(ruleOf('answer', 'has_all_words', { values: ['plainly'] }));
  const wide = group(ruleOf('answer', 'is_not_empty'));
  const page = await read(account({ gamma: { strictness: { rules: own, review: true } }, view: { strictness: { rules: wide } } }), { method: VIEW });
  const gamma = page.rows.find(row => row.id === ROW('gamma'));
  assert.deepEqual([gamma.strictness.from, gamma.strictness.review, gamma.strictness.rules], ['row', true, own]);
  assert.deepEqual(page.rows.filter(row => row.id !== ROW('gamma')).map(row => row.strictness.from), ['method', 'method']);
  assert.deepEqual(page.strictness.rules, wide);
});

test('a method is read a page at a time, and a page ends before it holds more bytes than the DATA allows', async () => {
  const door = account();
  const first = await read(door, { method: VIEW, limit: 2 });
  assert.deepEqual(first.rows.map(row => row.values.title), ['Beta section', 'Gamma section']);
  assert.equal(first.next, '2');
  const second = await read(door, { method: VIEW, limit: 2, after: first.next });
  assert.deepEqual(second.rows.map(row => row.values.title), ['Alpha section']);
  assert.equal(second.next, null);
  const big = 'x'.repeat(Math.ceil(settings.read.page_bytes * 0.6));
  const heavy = await read(account({ rows: { alpha: { title: 'Alpha section', kind: 'section', 'document.offset': 30, note: big }, beta: { title: 'Beta section', kind: 'section', 'document.offset': 10, note: big } } }), { method: VIEW });
  assert.deepEqual(heavy.rows.map(row => row.values.title), ['Beta section', 'Gamma section'], 'the page ends before the row that would pass the bytes: Alpha is not there');
  assert.equal(heavy.next, '2');
  const rest = await read(account({ rows: { alpha: { title: 'Alpha section', kind: 'section', 'document.offset': 30, note: big }, beta: { title: 'Beta section', kind: 'section', 'document.offset': 10, note: big } } }), { method: VIEW, after: heavy.next });
  assert.deepEqual(rest.rows.map(row => row.values.title), ['Alpha section']);
});

test('a method that is not there, a limit past the most, and a view the rule filter cannot use are refused by name', async () => {
  const door = account();
  await assert.rejects(read(door, { method: 'list-view:nothing' }), /There is no saved method list-view:nothing/);
  await assert.rejects(read(door, { method: VIEW, limit: settings.read.page_rows_most + 1 }), /limit is a whole number/);
  door.put(VIEW, 'list-view', { list_id: 'sample-methods', view: { rules: group(ruleOf('kind', 'is_not_a_known_operator')) } });
  await assert.rejects(read(door, { method: VIEW }), /cannot be read/);
});

test('a field the call does not declare is refused by name', async () => {
  const door = account();
  await assert.rejects(read(door, { method: VIEW, rows: 5 }), /rows is not a field of this tool; it takes method, after, limit/);
  await assert.rejects(record(door, { answers: [{ row: ROW('beta'), answer: 'x', cites: [ROW('gamma')] }], judge: 'second' }), /judge is not a field of this tool/);
});

test('answers for rows of the method are recorded in one call, with what they cite, and read back', async () => {
  const door = account();
  const done = await record(door, { answers: [
    { row: ROW('beta'), answer: 'Beta is met by the made-up fact', evidence_refs: ['e1'] },
    { row: ROW('gamma'), answer: 'Gamma rests on the made-up beta row', cites: [ROW('beta')] },
    { row: ROW('alpha'), answer: 'Alpha rests on the fact laid beside the decision', evidence_refs: ['e2'], cites: [ROW('gamma')] },
  ] });
  assert.deepEqual(done.recorded.map(item => [item.row, item.version]), [[ROW('beta'), 1], [ROW('gamma'), 1], [ROW('alpha'), 1]]);
  assert.deepEqual([done.refused, done.unchanged, done.answered, done.rows], [[], [], 3, 3]);
  const kept = door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('alpha'))}`);
  assert.deepEqual([kept.answer, kept.cites, kept.evidence_refs, kept.method, kept.version, kept.by, kept.strictness], ['Alpha rests on the fact laid beside the decision', [ROW('gamma')], ['e2'], VIEW, 1, 'calling-ai', 'default']);
  assert.equal(kept.review, undefined, 'no review is asked where the strictness does not say so');
});

test('the same answer again is unchanged, a different one is the next version, and who answered is kept', async () => {
  const door = account();
  const answer = { row: ROW('beta'), answer: 'Beta is met by the made-up fact', evidence_refs: ['e1'] };
  await record(door, { answers: [answer], by: 'a made-up ai' });
  const again = await record(door, { answers: [answer] });
  assert.deepEqual([again.recorded, again.unchanged], [[], [ROW('beta')]]);
  const changed = await record(door, { answers: [{ ...answer, answer: 'Beta is met in other words' }], by: 'a made-up ai' });
  assert.deepEqual(changed.recorded.map(item => item.version), [2]);
  assert.equal(door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('beta'))}`).by, 'a made-up ai');
});

test('an answer that fails a check is named with why and nothing of it is written, and the others are recorded', async () => {
  const door = account();
  const done = await record(door, { answers: [
    { row: ROW('beta'), answer: 'Beta is met by the made-up fact', evidence_refs: ['e1'] },
    { row: ROW('file'), answer: 'The file is not a row of this method', evidence_refs: ['e1'] },
    { row: ROW('gamma'), answer: 'Gamma cites a row outside the method', cites: [ROW('file')] },
    { row: ROW('alpha'), answer: 'Alpha cites evidence the decision does not hold', evidence_refs: ['nope'] },
    { row: 'record:method-row:sample-methods~missing', answer: 'No such row', evidence_refs: ['e1'] },
    { row: ROW('beta'), answer: 'Beta twice in one call', evidence_refs: ['e1'] },
    { row: 'record:method-row:x', answer: 7 },
  ] });
  assert.deepEqual(done.recorded.map(item => item.row), [ROW('beta')]);
  const why = Object.fromEntries(done.refused.map(item => [item.row, item.why]));
  assert.match(why[ROW('file')], /is not one of the rows of method/);
  assert.match(why[ROW('gamma')], /cites .*sample-methods~file, which is not one of the rows/);
  assert.match(why[ROW('alpha')], /cites evidence nope, which is not evidence of decision/);
  assert.match(why['record:method-row:sample-methods~missing'], /is not one of the rows/);
  assert.match(why[ROW('beta')], /answered twice in one call/);
  assert.match(why['record:method-row:x'], /is not \{ row, answer/);
  assert.equal(door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('gamma'))}`), null);
  assert.equal(door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('alpha'))}`), null);
});

test('retracted evidence is not citable, evidence laid beside the decision is', async () => {
  const done = await record(account(), { answers: [
    { row: ROW('beta'), answer: 'Beta cites retracted evidence', evidence_refs: ['gone'] },
    { row: ROW('gamma'), answer: 'Gamma cites laid evidence', evidence_refs: ['e2'] },
  ] });
  assert.deepEqual(done.recorded.map(item => item.row), [ROW('gamma')]);
  assert.match(done.refused[0].why, /evidence gone/);
});

test('the default asks only the cheap check: the answer says something and cites a row or a piece of evidence', async () => {
  const done = await record(account(), { answers: [
    { row: ROW('beta'), answer: '', evidence_refs: ['e1'] },
    { row: ROW('gamma'), answer: 'Gamma says something but cites nothing' },
    { row: ROW('alpha'), answer: 'Alpha cites a row only', cites: [ROW('beta')] },
  ] });
  assert.deepEqual(done.recorded.map(item => item.row), [ROW('alpha')]);
  const why = Object.fromEntries(done.refused.map(item => [item.row, item.why]));
  assert.match(why[ROW('beta')], /does not pass its strictness: answer is_not_empty/);
  assert.match(why[ROW('gamma')], /does not pass its strictness: cites is_not_empty, evidence_refs is_not_empty/);
});

test('strictness is open: a row asks for what its own rules say, and review is asked only where it says so', async () => {
  const strict = { rules: group(ruleOf('answer', 'has_all_words', { values: ['because'] }), ruleOf('evidence_refs', 'has_all_of', { values: ['e1', 'e2'] })), says: 'Say because, and rest on both facts.', review: true };
  const door = account({ gamma: { strictness: strict } });
  const done = await record(door, { answers: [
    { row: ROW('gamma'), answer: 'Yes because both facts say so', evidence_refs: ['e1', 'e2'] },
    { row: ROW('beta'), answer: 'Beta is met by the made-up fact', evidence_refs: ['e1'] },
  ] });
  assert.deepEqual(done.recorded, [{ row: ROW('gamma'), version: 1, review: 'asked' }, { row: ROW('beta'), version: 1 }]);
  const asked = door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('gamma'))}`);
  assert.equal(asked.strictness, 'row');
  assert.match(asked.review_job, new RegExp(`The decision is ${DECISION}\\. The method is ${VIEW}\\. The row is ${ROW('gamma')}\\.`));
  assert.equal(asked.review_said, `Review the answer to ${ROW('gamma')}`);
  assert.equal(door.value(`method-answer:${DECISION}:${encodeURIComponent(ROW('beta'))}`).review_job, undefined, 'no review words where none is asked');
  const refused = await record(door, { answers: [{ row: ROW('gamma'), answer: 'Yes, with one fact', evidence_refs: ['e1'] }] });
  assert.equal(refused.refused[0].why, `Row ${ROW('gamma')} does not pass its strictness: Say because, and rest on both facts.`);
});

test('strictness a rule filter cannot use is named, never read as passing', async () => {
  const door = account({ gamma: { strictness: { rules: group(ruleOf('answer', 'is_not_a_known_operator')) } } });
  const done = await record(door, { answers: [{ row: ROW('gamma'), answer: 'Gamma', evidence_refs: ['e1'] }] });
  assert.deepEqual(done.recorded, []);
  assert.match(done.refused[0].why, /strictness of row .* cannot be checked/);
});

test('a decision that is not there, a method that is not there and an empty call are refused before anything is written', async () => {
  const door = account();
  await assert.rejects(recordMethodAnswers({ decision_id: 'source:nope', method: VIEW, answers: [{ row: ROW('beta'), answer: 'x', cites: [ROW('gamma')] }] }, { door: granted(door, 'tool:record-method-answers') }), /There is no decision source:nope/);
  await assert.rejects(record(door, { method: 'list-view:nothing', answers: [{ row: ROW('beta'), answer: 'x' }] }), /There is no saved method/);
  await assert.rejects(record(door, { answers: [] }), /Send answers/);
  await assert.rejects(record(door, { answers: [{ row: ROW('beta'), answer: 'x', cites: [ROW('gamma')] }], by: 'x'.repeat(settings.answers.by_max_chars + 1) }), /at most 200 characters/);
  assert.deepEqual(door.writes, []);
});

test('any number of answers is recorded in one call, in writes that each fit the door\'s message', async () => {
  const extra = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`row-${n}`, { title: `Made-up section ${n}`, kind: 'section', 'document.offset': 100 + n }]));
  const door = account({ rows: extra });
  const answers = Array.from({ length: 300 }, (_, n) => ({ row: ROW(`row-${n}`), answer: `Made-up answer ${n} ${'in words '.repeat(60)}`, evidence_refs: ['e1'] }));
  const done = await record(door, { answers });
  assert.equal(done.recorded.length, 300);
  assert.equal(done.answered, 300);
  assert.ok(door.writes.length > 1, 'three hundred answers do not fit one write');
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024));
  const again = await record(door, { answers });
  assert.deepEqual([again.recorded.length, again.unchanged.length], [0, 300]);
});

test('the two rows declare exactly the kinds and operations their code uses, and name no list of the person\'s', () => {
  for (const id of ['tool:read-a-method', 'tool:record-method-answers']) {
    const row = rows.find(each => each.id === id);
    assert.ok(row, `${id} has a row`);
    assert.equal(row.invoke.records.rights.some(item => item.operations.includes('records:write')), id === 'tool:record-method-answers', `${id} writes only if it records`);
  }
  const rights = Object.fromEntries(rows.find(each => each.id === 'tool:record-method-answers').invoke.records.rights.map(item => [item.kind, item.operations]));
  assert.deepEqual(rights['method-answer'], ['records:read', 'records:list', 'records:write']);
  assert.deepEqual(Object.keys(rights).filter(kind => rights[kind].includes('records:write')), ['method-answer']);
});

test('the rule the tool ships hands an answer whose review is asked to an AI, with the words the answer carries, and nothing else', async () => {
  const shipped = JSON.parse(readFileSync(new URL('../starting-rules.json', import.meta.url), 'utf8')).every_account;
  assert.equal(shipped.length, 1);
  const [rule] = shipped;
  const { review_field: field, review_asked: asked, review_job_field: job, review_said_field: said } = settings.strictness;
  assert.deepEqual([rule.when.recorded, rule.when.where], [settings.answers.type, [{ field, equals: asked }]]);
  assert.deepEqual([rule.then.input.job.fill.field, rule.then.input.said.fill.field, rule.then.input.once_per.fill.field], [job, said, 'id']);
  const door = account({ gamma: { strictness: { rules: group(ruleOf('answer', 'is_not_empty')), review: true } } });
  await record(door, { answers: [{ row: ROW('gamma'), answer: 'Gamma', evidence_refs: ['e1'] }, { row: ROW('beta'), answer: 'Beta', evidence_refs: ['e1'] }] });
  const kept = [...door.records.values()].filter(held => held.type === settings.answers.type).map(held => held.value);
  const asking = kept.filter(value => value[field] === asked);
  assert.deepEqual(asking.map(value => value.row), [ROW('gamma')], 'only the answer whose strictness says review asks for one');
  assert.ok(asking.every(value => typeof value[job] === 'string' && typeof value[said] === 'string'));
});
