// test/practice.test.mjs
//
// Practice cards (src/practice.mjs): a card comes back on a spaced repetition schedule, grading moves it out or brings
// it back tomorrow, mastery counts how far out it holds, and one daily schedule reminds the person when cards are due.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makePractice, nextReview, masteryOf } from '../src/practice.mjs';

const DAY = 86_400_000;
const fakeIo = start => {
  const kept = new Map();
  const schedules = [];
  const told = [];
  let clock = start;
  return {
    kept, schedules, told,
    tick: days => { clock += days * DAY; },
    io: {
      list: () => [...kept.values()],
      put: (id, card) => kept.set(id, card),
      schedule: async input => { schedules.push(input); return { schedule_id: input.schedule_id }; },
      tell: async notice => { told.push(notice); },
      now: () => clock,
    },
  };
};

test('the schedule goes 1 day, 6 days, then interval times ease; a miss starts over and ease never drops below its floor', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const first = nextReview({}, 0.8, now);
  assert.equal(first.interval_days, 1);
  const second = nextReview(first, 0.8, now);
  assert.equal(second.interval_days, 6);
  const third = nextReview(second, 0.8, now);
  assert.equal(third.interval_days, Math.round(6 * third.ease));
  const missed = nextReview(third, 0, now);
  assert.equal(missed.reps, 0);
  assert.equal(missed.interval_days, 1);
  assert.equal(missed.mastery, 0);
  let card = third;
  for (let i = 0; i < 20; i += 1) card = nextReview(card, 0.6, now);
  assert.ok(card.ease >= 1.3);
  assert.equal(masteryOf(60), 1000);
  assert.equal(masteryOf(600), 1000);
  assert.throws(() => nextReview({}, 2, now), /from 0 to 1/);
});

test('a card is due when added, grading moves it out, and remind tells the person only when something is due', async () => {
  const fake = fakeIo(Date.parse('2026-10-05T16:00:00Z'));
  const practice = makePractice(fake.io);
  const added = await practice.run({ operation: 'add', prompt: 'Where do the tools live?', answer: 'Marketplace, and each time one ran is a Run.', why: 'Use the product words.', source_ref: 'fixture:product-words', time_zone: 'America/Los_Angeles' });
  assert.equal(added.source_ref, 'fixture:product-words');
  assert.equal(fake.schedules.length, 1);
  assert.equal(fake.schedules[0].schedule_id, 'practice-reminder');
  assert.equal(fake.schedules[0].then.input.operation, 'remind');
  const due = await practice.run({ operation: 'due' });
  assert.equal(due.cards.length, 1);
  assert.equal(due.cards[0].source_ref, 'fixture:product-words');
  assert.equal((await practice.run({ operation: 'cards' })).cards[0].source_ref, 'fixture:product-words');

  const graded = await practice.run({ operation: 'grade', card_id: added.card_id, grade: 'good' });
  assert.equal(graded.source_ref, 'fixture:product-words');
  assert.equal(graded.due_at, '2026-10-06T16:00:00.000Z');
  assert.match(graded.said, /comes back on 2026-10-06, mastery 17 of 1000: Where do the tools live?/);
  assert.equal((await practice.run({ operation: 'due' })).cards.length, 0);
  assert.equal((await practice.run({ operation: 'remind' })).cards.length, 0);
  assert.equal(fake.told.length, 0);

  fake.tick(1);
  const reminded = await practice.run({ operation: 'remind' });
  assert.equal(reminded.cards.length, 1);
  assert.equal(fake.told.length, 1);

  const missed = await practice.run({ operation: 'grade', card_id: added.card_id, grade: 'again' });
  assert.match(missed.said, /Missed, so it comes back tomorrow: .* The answer: Marketplace/);
  assert.equal(missed.lapses, 1);

  // Adding the same card again keeps its progress; removing it stops it coming back.
  await practice.run({ operation: 'add', prompt: 'Where do the tools live?', answer: 'Marketplace (Yours and Everyone\'s); each run is a Run.' });
  assert.equal(fake.kept.size, 1);
  assert.equal([...fake.kept.values()][0].lapses, 1);
  assert.equal((await practice.run({ operation: 'cards' })).cards[0].source_ref, 'fixture:product-words', 'editing the answer without a source field preserves its provenance');
  await practice.run({ operation: 'add', prompt: 'Where do the tools live?', answer: 'Marketplace.', source_ref: null });
  assert.equal((await practice.run({ operation: 'cards' })).cards[0].source_ref, null, 'explicit clearing still works');
  await practice.run({ operation: 'remove', card_id: added.card_id });
  assert.equal((await practice.run({ operation: 'cards' })).cards.length, 0);
  await assert.rejects(practice.run({ operation: 'grade', card_id: added.card_id, grade: 'good' }), /No card/);
  await assert.rejects(practice.run({ operation: 'grade', card_id: 'x', grade: 'perfect' }), /No card/);
  await assert.rejects(practice.run({ operation: 'fly' }), /operation is one of/);
});
