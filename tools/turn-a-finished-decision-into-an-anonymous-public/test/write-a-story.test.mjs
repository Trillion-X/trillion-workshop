// Writing a finished decision as a public story: the facts are redacted before any model, one model writes, the plain
// pass and the second model must each find nothing, a leak goes back to the writer, a held kind is never shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyPrivateTerms, writeStory } from '../read-data/write-a-story.mjs';
import settings from '../read-data/story-settings.json' with { type: 'json' };

const PRIVATE = ['jordan', 'riley', 'harbor', 'morales', 'jordan@example.com', '$4,800'];
const record = {
  id: 'case-1',
  input: {
    goal: 'Decide whether Jordan should move Riley to the Harbor Club academy before the spring season',
    evidence: [
      { ref: 'a', claim: 'Riley has lost four of the last five matches on the second serve, and coach Morales says the grip is the cause.' },
      { ref: 'b', claim: 'The academy costs $4,800 a term; write to jordan@example.com for the invoice.' },
    ],
    options: [
      { id: 'move', label: 'Move Riley to the academy at Harbor Club now' },
      { id: 'grip', label: 'Keep training at home and fix the second-serve grip first' },
    ],
  },
  decision: { option_id: 'grip', reason: 'The losses come from one fixable stroke, and the fix costs less at home.', next_action: 'Book three grip sessions this week.', success_measure: 'Second-serve points won rise above half.' },
  reports: [{ result: 'met', summary: 'Three of four matches were won after the grip change.', reported_at: '2026-09-20T10:00:00Z' }],
};
const models = { rewrite: 'writer-model', check: 'checker-model' };
const WORDS = { held_kind: 'You keep {kind} decisions private, so this one is not published.' };
const terms = () => storyPrivateTerms(record, ['Jordan Example'], []);
const GOOD = {
  kind: 'sport-and-training',
  title: 'Fixing one stroke before changing clubs',
  summary: 'A young player kept losing on one stroke, so the family fixed the stroke before moving clubs.',
  situation: 'A junior player kept losing close matches on the second serve. A move to an expensive academy was on the table.',
  options: ['Move to the academy now', 'Fix the second-serve grip at home first'],
  chosen: 'Fix the second-serve grip at home first',
  why: 'The losses came from one fixable stroke, and the fix was cheaper at home.',
  next_step: 'Book a few grip sessions this week.',
  measured_by: 'Winning more than half of second-serve points over the next matches.',
  outcome: 'The player won most of the next matches after the change.',
};

// A stand-in for the caller's model adapter: `rewrite` answers the writer, `check` the checking model. Every call is kept.
function fakeAsk({ rewrite, check = () => ({ identifying: [] }) }) {
  const calls = [];
  const ask = async (model, system, user) => {
    calls.push({ model, system, user });
    return system.startsWith('You try to re-identify') ? check(user) : rewrite(JSON.parse(user));
  };
  return { ask, calls };
}

test('the plain pass finds the account name, the people, places, money and address in the record, and not a sentence\'s first word', () => {
  const found = terms();
  for (const word of ['jordan', 'riley', 'harbor', 'morales']) assert.ok(found.has(word), word);
  assert.ok(!found.has('decide') && !found.has('book'), 'a sentence\'s first word is not a name');
});

test('no model sees a private name: the facts are redacted before the writer, and the story is shared', async () => {
  const env = fakeAsk({ rewrite: () => GOOD });
  const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
  assert.equal(written.shared, true);
  assert.equal(written.story.outcome.result, 'met');
  assert.equal(written.story.kind, 'sport-and-training');
  for (const call of env.calls) for (const word of PRIVATE) assert.ok(!call.user.toLowerCase().includes(word), `a model was sent ${word}`);
  for (const word of PRIVATE) assert.ok(!JSON.stringify(written.story).toLowerCase().includes(word), `the story carries ${word}`);
  assert.deepEqual(env.calls.map(call => call.model), ['writer-model', 'checker-model']);
});

test('a story that brings a private name back is never shared, even when the checking model sees nothing', async () => {
  for (const leak of ['Riley', 'JORDAN', 'the Harbor academy', 'coach Morales', 'write to jordan@example.com', 'it cost $4,800']) {
    const env = fakeAsk({ rewrite: () => ({ ...GOOD, situation: `${GOOD.situation} ${leak}.` }) });
    const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
    assert.equal(written.shared, false, `${leak} was shared`);
    for (const word of PRIVATE) assert.ok(!String(written.reason).toLowerCase().includes(word), `the refusal repeats ${word}`);
  }
});

test('the checking model\'s finding goes back to the writer, which is asked again, and after the last try nothing is shared', async () => {
  let writes = 0;
  const env = fakeAsk({ rewrite: () => { writes += 1; return GOOD; }, check: () => ({ identifying: ['a junior player'] }) });
  const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
  assert.equal(written.shared, false);
  assert.equal(writes, settings.rewrite.rounds);
  assert.match(written.reason, /tries/);
});

test('the checking model is told where stories appear', async () => {
  const env = fakeAsk({ rewrite: () => GOOD });
  await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
  const check = env.calls.find(call => call.model === 'checker-model');
  assert.ok(check.system.includes(settings.privacy.publisher_context));
});

test('a kind the owner keeps private is never shared, however well its words are hidden', async () => {
  const env = fakeAsk({ rewrite: () => ({ ...GOOD, kind: 'products-and-launches' }) });
  const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms(), heldKinds: ['products-and-launches'], words: WORDS });
  assert.equal(written.shared, false);
  assert.match(written.reason, /private/);
});

test('an unlisted kind is filed under the fallback kind', async () => {
  const env = fakeAsk({ rewrite: () => ({ ...GOOD, kind: 'astrology' }) });
  const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
  assert.equal(written.story.kind, settings.kinds.find(kind => kind.fallback).id);
});

test('a rewrite without a title or with one option is incomplete and not shared', async () => {
  const noTitle = fakeAsk({ rewrite: () => ({ ...GOOD, title: '' }) });
  assert.deepEqual(await writeStory({ ask: noTitle.ask, models }, record, { words: WORDS, terms: terms() }), { shared: false, reason: 'The rewrite was incomplete.' });
  const oneOption = fakeAsk({ rewrite: () => ({ ...GOOD, options: ['Only one'] }) });
  assert.equal((await writeStory({ ask: oneOption.ask, models }, record, { words: WORDS, terms: terms() })).shared, false);
});

test('a rewrite still carrying the removed mark is sent back, never shared', async () => {
  let writes = 0;
  const env = fakeAsk({ rewrite: () => { writes += 1; return { ...GOOD, why: `${GOOD.why} [removed] was kept.` }; } });
  const written = await writeStory({ ask: env.ask, models }, record, { words: WORDS, terms: terms() });
  assert.equal(written.shared, false);
  assert.equal(writes, settings.rewrite.rounds);
});

test('the product words are the caller\'s: a call without them is refused, not defaulted', async () => {
  const env = fakeAsk({ rewrite: () => GOOD });
  await assert.rejects(writeStory({ ask: env.ask, models }, record, { terms: terms() }), /product words/);
});
