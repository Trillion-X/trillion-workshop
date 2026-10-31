// tool:practice against the stand-in records door. Every card, deck and grade here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { practice, readSettings } from '../read-data/practice-cards.mjs';

const settings = readSettings();
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === 'tool:practice');
const policy = { initial_ease: 2.5, min_ease: 1.3, first_interval_days: 1, second_interval_days: 6, lapse_below_quality: 0.4, grade_quality: { again: 0, hard: 0.5, good: 0.75, easy: 1 }, mastered_at_days: 30 };
const day = n => new Date(Date.UTC(2026, 0, 1 + n, 9));

async function withDoor(records, run) {
  const door = await startFakeDoor({ rights: row.invoke.records.rights, mostWrites: row.invoke.records.most_writes, records });
  try { await run(openRecordsDoor({ descriptor: door.descriptor }), door); } finally { await door.close(); }
}
const ask = (door, input, n = 0) => practice({ policy, ...input }, { door, now: () => day(n) });

test('a card is kept once, adding the same prompt again keeps its progress, and a graded card waits its gap', async () => {
  await withDoor([], async (door, fake) => {
    const first = await ask(door, { operation: 'add', prompt: 'Which dough rests longest?', answer: 'Rye', deck: 'bread' });
    assert.equal(first.kept_progress, false);
    assert.match(first.card_id, /^card:bread:[0-9a-f]{16}$/);
    const graded = await ask(door, { operation: 'grade', card_id: first.card_id, grade: 'good' }, 0);
    const again = await ask(door, { operation: 'add', prompt: 'Which dough rests longest?', answer: 'Rye, overnight', why: 'for the shelf', deck: 'bread' }, 1);
    assert.equal(again.card_id, first.card_id);
    assert.equal(again.kept_progress, true);
    assert.equal(fake.kept.get(first.card_id).value.answer, 'Rye, overnight');
    assert.equal(fake.kept.get(first.card_id).value.why, 'for the shelf');
    assert.equal(graded.due_at, day(1).toISOString());
    assert.equal((await ask(door, { operation: 'due', deck: 'bread' }, 0)).due_count, 0, 'graded good today: back tomorrow');
    assert.equal((await ask(door, { operation: 'due', deck: 'bread' }, 1)).due_count, 1);
  });
});

test('grades push a card out, a miss brings it back, and mastery reads from its interval', async () => {
  await withDoor([], async door => {
    const { card_id: id } = await ask(door, { operation: 'add', prompt: 'p', answer: 'a' });
    const one = await ask(door, { operation: 'grade', card_id: id, grade: 'good' }, 0);
    const two = await ask(door, { operation: 'grade', card_id: id, grade: 'easy' }, 1);
    assert.equal(two.due_at, day(7).toISOString(), 'the second success waits the policy\'s second gap');
    assert.equal(two.mastery, Math.round((6 / 30) * 1000));
    assert.ok(one.mastery < two.mastery);
    const missed = await ask(door, { operation: 'grade', card_id: id, grade: 'again' }, 7);
    assert.equal(missed.lapsed, true);
    assert.equal(missed.due_at, day(8).toISOString());
    assert.equal((await ask(door, { operation: 'grade', card_id: id, grade: 'whatever' }, 8)).grade_in_policy, false, 'a grade word the policy does not list counts as a lapse and says so');
  });
});

test('cards lists every card with its standing, due lists a limit, remove stops a card coming back, remind counts', async () => {
  await withDoor([], async door => {
    for (const n of [1, 2, 3]) await ask(door, { operation: 'add', prompt: `p${n}`, answer: `a${n}`, deck: n === 3 ? 'other' : 'bread' });
    const cards = (await ask(door, { operation: 'cards' })).cards;
    assert.equal(cards.length, 3);
    assert.ok(cards.every(card => card.due && card.reviews === 0 && card.mastery === null));
    assert.equal((await ask(door, { operation: 'cards', deck: 'bread' })).cards.length, 2);
    const limited = await ask(door, { operation: 'due', limit: 1 });
    assert.deepEqual([limited.due_count, limited.cards.length], [3, 1]);
    assert.equal((await ask(door, { operation: 'remind' })).said, '3 cards are due to practise now.');
    await ask(door, { operation: 'remove', card_id: cards[0].card_id });
    const left = (await ask(door, { operation: 'cards' })).cards;
    assert.equal(left.length, 2);
    for (const card of left) await ask(door, { operation: 'grade', card_id: card.card_id, grade: 'good' });
    assert.equal((await ask(door, { operation: 'remind' })).said, 'Nothing is due to practise now.');
  });
});

test('the policy is the person\'s record, or comes with the request, and there is no default', async () => {
  const kept = { id: `${settings.types.policy}:${settings.default_policy_id}`, type: settings.types.policy, value: policy };
  await withDoor([kept], async door => {
    const added = await practice({ operation: 'add', prompt: 'p', answer: 'a' }, { door, now: () => day(0) });
    const graded = await practice({ operation: 'grade', card_id: added.card_id, grade: 'good' }, { door, now: () => day(0) });
    assert.equal(graded.due_at, day(1).toISOString());
  });
  await withDoor([], async door => {
    const added = await practice({ operation: 'add', prompt: 'p', answer: 'a' }, { door, now: () => day(0) });
    await assert.rejects(practice({ operation: 'due' }, { door }), /No spacing policy is kept/);
    await assert.rejects(practice({ operation: 'grade', card_id: added.card_id, grade: 'good' }, { door }), /No spacing policy is kept/);
  });
});

test('a request that is not plainly shaped is refused', async () => {
  await withDoor([], async door => {
    await assert.rejects(ask(door, { operation: 'shuffle' }), /operation is one of/);
    await assert.rejects(ask(door, { operation: 'add', prompt: 'p' }), /add needs an answer/);
    await assert.rejects(ask(door, { operation: 'add', prompt: 'p', answer: 'a', deck: 'a b' }), /deck is made of/);
    await assert.rejects(ask(door, { operation: 'grade', card_id: 'card:none', grade: 'good' }), /No card card:none is kept/);
    await assert.rejects(practice(null, { door }), /Send an object/);
  });
});

test('the row packs what the tool reads and holds only the rights of its three record types', () => {
  const { invoke } = row;
  assert.deepEqual(invoke.records.rights.map(item => item.kind).sort(), Object.values(settings.types).sort());
  assert.deepEqual(invoke.records.rights.find(item => item.kind === settings.types.policy).operations, ['records:read']);
  const packs = invoke.files.package_files.map(item => item.package ?? item.module);
  for (const name of ['practice-and-review', 'content-identity', 'records-door', '@noble/hashes']) assert.ok(packs.includes(name), name);
});
