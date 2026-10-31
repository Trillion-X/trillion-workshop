// tools/guided-tours: the tour mechanism over made-up bakery tours. Carries the package's engine tests (branching,
// cursor moves, advance conditions, trigger matching and suppression) and its record-fold tests, rewritten over
// synthetic tours.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, canAdvance, createAdvanceOps, currentStep, eventMatchesTrigger, foldTours, jump, resolveBranch, restart, retreat,
  selectTourForEvent, selectTrigger, shouldFireTrigger, startEventForTour, startTour, suppressionKeyForEvent,
} from '../do-work/tour.mjs';

const linear = { entry_step: 's1', steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
const branched = {
  entry_step: 'welcome',
  steps: [
    { id: 'welcome', branch_map: { by_answer: { beginner: 'basics', pro: 'advanced' }, default_next: 'basics' } },
    { id: 'basics' }, { id: 'advanced' }, { id: 'done' },
  ],
};

test('a step goes to the route its answer names, else its default, else the next step in order', () => {
  const step = branched.steps[0];
  assert.equal(resolveBranch(step, 'pro', 'basics'), 'advanced');
  assert.equal(resolveBranch(step, 'unknown-answer', 'basics'), 'basics');
  assert.equal(resolveBranch({ id: 'x' }, undefined, 's2'), 's2');
  assert.equal(resolveBranch({ id: 'x' }, undefined, null), null);
  assert.equal(resolveBranch({ id: 'x', branch_map: { by_answer: { a: 'b' } } }, 'z', 'next'), 'next');
});

test('a linear tour starts at its entry, moves on one step at a time and completes on the last step', () => {
  let cursor = startTour(linear);
  assert.deepEqual(cursor, { currentStepId: 's1', history: [], status: 'active' });
  cursor = advance(linear, cursor);
  assert.deepEqual([cursor.currentStepId, cursor.history], ['s2', ['s1']]);
  cursor = advance(linear, advance(linear, cursor));
  assert.deepEqual([cursor.status, cursor.currentStepId], ['complete', 's3']);
  assert.equal(advance(linear, cursor), cursor);
});

test('an answer routes a branching tour; an unmatched answer takes the default', () => {
  const pro = advance(branched, startTour(branched), 'pro');
  assert.equal(pro.currentStepId, 'advanced');
  assert.equal(currentStep(branched, pro).id, 'advanced');
  assert.equal(advance(branched, startTour(branched), 'martian').currentStepId, 'basics');
});

test('a route to a step the tour does not have completes it instead of getting lost', () => {
  const broken = { entry_step: 'a', steps: [{ id: 'a', branch_map: { default_next: 'ghost' } }] };
  assert.equal(advance(broken, startTour(broken)).status, 'complete');
});

test('back undoes exactly, even across a branch; with nothing behind it changes nothing', () => {
  const onAdvanced = advance(branched, startTour(branched), 'pro');
  const back = retreat(onAdvanced);
  assert.deepEqual(back, { currentStepId: 'welcome', history: [], status: 'active' });
  assert.equal(retreat(back), back);
});

test('jump goes to a step and remembers where it came from; an unknown step changes nothing; restart clears the way back', () => {
  const at = jump(linear, startTour(linear), 's3');
  assert.deepEqual([at.currentStepId, at.history], ['s3', ['s1']]);
  assert.equal(jump(linear, at, 'nope'), at);
  assert.deepEqual(restart(branched), { currentStepId: 'welcome', history: [], status: 'active' });
});

test('simple advance conditions read the signals', () => {
  assert.equal(canAdvance({ op: 'tap-next' }, { nextTapped: true }), true);
  assert.equal(canAdvance({ op: 'tap-next' }, {}), false);
  assert.equal(canAdvance({ op: 'target-interacted' }, { targetInteracted: true }), true);
  assert.equal(canAdvance({ op: 'answer-given' }, { answer: 'pro' }), true);
  assert.equal(canAdvance({ op: 'answer-given' }, { answer: '' }), false);
});

test('thresholds are in the condition: media watched, timeout, a named completion', () => {
  assert.equal(canAdvance({ op: 'media-watched', args: { min_ratio: 0.9 } }, { mediaRatio: 0.95 }), true);
  assert.equal(canAdvance({ op: 'media-watched', args: { min_ratio: 0.9 } }, { mediaRatio: 0.5 }), false);
  assert.equal(canAdvance({ op: 'media-watched' }, { mediaRatio: 0.99 }), false);
  assert.equal(canAdvance({ op: 'timeout', args: { ms: 3000 } }, { elapsedMs: 3001 }), true);
  assert.equal(canAdvance({ op: 'timeout', args: { ms: 3000 } }, { elapsedMs: 100 }), false);
  const done = { op: 'surface-completed', args: { completion_ref: 'order-form' } };
  assert.equal(canAdvance(done, {}), false);
  assert.equal(canAdvance(done, { surfaceCompletionRefs: ['other-form'] }), false);
  assert.equal(canAdvance(done, { surfaceCompletionRefs: ['order-form'] }), true);
});

test('an op nobody defined holds the step where it is', () => {
  assert.equal(canAdvance({ op: 'telepathy' }, { nextTapped: true }), false);
});

test('all-of and any-of compose any conditions, nested as deep as written', () => {
  const watchedAndAnswered = { op: 'all-of', args: { of: [{ op: 'media-watched', args: { min_ratio: 0.9 } }, { op: 'answer-given' }] } };
  assert.equal(canAdvance(watchedAndAnswered, { mediaRatio: 0.95, answer: 'x' }), true);
  assert.equal(canAdvance(watchedAndAnswered, { mediaRatio: 0.95 }), false);
  assert.equal(canAdvance(watchedAndAnswered, { answer: 'x' }), false);
  assert.equal(canAdvance({ op: 'all-of', args: { of: [] } }, {}), false);
  const tappedOrTimedOut = { op: 'any-of', args: { of: [{ op: 'tap-next' }, { op: 'timeout', args: { ms: 5000 } }] } };
  assert.equal(canAdvance(tappedOrTimedOut, { nextTapped: true }), true);
  assert.equal(canAdvance(tappedOrTimedOut, { elapsedMs: 6000 }), true);
  assert.equal(canAdvance(tappedOrTimedOut, {}), false);
  assert.equal(canAdvance({ op: 'any-of', args: { of: [{ op: 'tap-next' }, watchedAndAnswered] } }, { mediaRatio: 1, answer: 'y' }), true);
});

test('a new op is one entry in the table and composes with the built-in ones', () => {
  const ops = createAdvanceOps();
  ops.set('shook-phone', (_args, signals) => signals.shaken === true);
  assert.equal(canAdvance({ op: 'any-of', args: { of: [{ op: 'shook-phone' }, { op: 'tap-next' }] } }, { shaken: true }, ops), true);
});

test('a looked-up fact gates the step only when every named fact is there and fits', () => {
  const present = { op: 'owner-readback', args: { readback_ref: 'oven:state' } };
  assert.equal(canAdvance(present, {}), false);
  assert.equal(canAdvance(present, { ownerReadbacks: {} }), false);
  assert.equal(canAdvance(present, { ownerReadbacks: { 'oven:state': { state: 'hot' } } }), true);

  const answers = { op: 'owner-readback', args: { answer_fact_ref: 'quiz:q1', required_answer_values: ['rye', 'spelt'] } };
  assert.equal(canAdvance(answers, { ownerReadbacks: { 'quiz:q1': 'rye' } }), true);
  assert.equal(canAdvance(answers, { ownerReadbacks: { 'quiz:q1': 'corn' } }), false);
  assert.equal(canAdvance(answers, { ownerReadbacks: { other: 'rye' } }), false);

  const nonEmpty = { op: 'owner-readback', args: { readback_ref: 'orders', required_nonempty: true } };
  assert.equal(canAdvance(nonEmpty, { ownerReadbacks: { orders: [] } }), false);
  assert.equal(canAdvance(nonEmpty, { ownerReadbacks: { orders: [{ id: 1 }] } }), true);
  assert.equal(canAdvance(nonEmpty, { ownerReadbacks: { orders: '  ' } }), false);

  const holds = { op: 'owner-readback', args: { readback_ref: 'badges', required_values_present: ['badge:baker'] } };
  assert.equal(canAdvance(holds, { ownerReadbacks: { badges: ['badge:cook'] } }), false);
  assert.equal(canAdvance(holds, { ownerReadbacks: { badges: ['badge:cook', 'badge:baker'] } }), true);

  const states = { op: 'owner-readback', args: { readback_ref: 'tray', required_states: ['proofing'] } };
  assert.equal(canAdvance(states, { ownerReadbacks: { tray: { visible_state: 'proofing' } } }), true);
  assert.equal(canAdvance(states, { ownerReadbacks: { tray: { visible_state: 'baked' } } }), false);

  const both = { op: 'owner-readback', args: { readback_ref: 'r1', objective_answer_ref: 'r2' } };
  assert.equal(canAdvance(both, { ownerReadbacks: { r1: 'ok' } }), false);
  assert.equal(canAdvance(both, { ownerReadbacks: { r1: 'ok', r2: 'text' } }), true);
});

const welcome = { reason: 'first-visit', on_event: { event_kind: 'shop-opened' }, once_key: 'tour.welcome' };
const spotlight = { reason: 'page-entered', on_event: { event_kind: 'page-entered', match: { page: 'menu' } }, once_key: 'tour.menu' };
const replay = { reason: 'manual', on_event: { event_kind: 'replay-requested', match: { tour: 'tour-a' } } };

test('a trigger matches its event kind and every field it names', () => {
  assert.equal(eventMatchesTrigger(welcome, { event_kind: 'shop-opened' }), true);
  assert.equal(eventMatchesTrigger(welcome, { event_kind: 'other' }), false);
  assert.equal(eventMatchesTrigger(spotlight, { event_kind: 'page-entered', page: 'menu' }), true);
  assert.equal(eventMatchesTrigger(spotlight, { event_kind: 'page-entered', page: 'cart' }), false);
  assert.equal(eventMatchesTrigger(spotlight, { event_kind: 'page-entered' }), false);
});

test('a used-up suppression key stops a trigger; a trigger without a key fires every time', () => {
  assert.equal(shouldFireTrigger(welcome, { event_kind: 'shop-opened' }, new Set()), true);
  assert.equal(shouldFireTrigger(welcome, { event_kind: 'shop-opened' }, new Set(['tour.welcome'])), false);
  const event = { event_kind: 'replay-requested', tour: 'tour-a' };
  assert.equal(shouldFireTrigger(replay, event, new Set(['anything'])), true);
});

test('a suppression key can be scoped by event fields the tour names, so one person does not use up another\'s tour', () => {
  const scoped = { reason: 'signed-in', on_event: { event_kind: 'session-read' }, once_key: 'tour', once_key_fields: ['account', 'revision'] };
  const event = { event_kind: 'session-read', account: 'acct-a', revision: 5 };
  assert.equal(suppressionKeyForEvent(scoped, event), 'tour::account=acct-a::revision=5');
  assert.equal(shouldFireTrigger(scoped, event, new Set(['tour'])), true);
  assert.equal(shouldFireTrigger(scoped, event, new Set(['tour::account=acct-a::revision=5'])), false);
  assert.equal(shouldFireTrigger(scoped, { ...event, account: 'acct-b' }, new Set(['tour::account=acct-a::revision=5'])), true);
  assert.equal(selectTrigger([scoped], event).once_key, 'tour::account=acct-a::revision=5');
  assert.equal(suppressionKeyForEvent(scoped, { event_kind: 'session-read' }), 'tour::account=__missing__::revision=__missing__');
});

test('the first trigger in the order written that fires is the one picked; none gives null', () => {
  const triggers = [welcome, spotlight, replay];
  assert.equal(selectTrigger(triggers, { event_kind: 'shop-opened' }).reason, 'first-visit');
  assert.equal(selectTrigger(triggers, { event_kind: 'page-entered', page: 'menu' }).reason, 'page-entered');
  assert.equal(selectTrigger(triggers, { event_kind: 'shop-opened' }, new Set(['tour.welcome'])), null);
  assert.equal(selectTrigger(triggers, { event_kind: 'nothing' }), null);
});

test('a trigger\'s reason is the author\'s own word and passes through untouched', () => {
  const odd = { reason: 'because-the-visitor-looked-lost', on_event: { event_kind: 'suggested', match: { tour: 'sourdough' } } };
  assert.equal(selectTrigger([odd], { event_kind: 'suggested', tour: 'sourdough' }).reason, 'because-the-visitor-looked-lost');
});

test('a Start control sends the tour\'s own repeatable trigger, not the first trigger', () => {
  const triggers = [
    { reason: 'signed-up', on_event: { event_kind: 'signed-up', match: { plan: 'free' } }, once_key: 'first-tour' },
    { reason: 'replay', on_event: { event_kind: 'tour-requested', match: { walkthrough_id: 'tour-a' } } },
  ];
  assert.deepEqual(startEventForTour(triggers, 'tour-a'), { event_kind: 'tour-requested', walkthrough_id: 'tour-a' });
  assert.deepEqual(startEventForTour([triggers[1]], 'tour-b'), null);
});

const bakeryTour = {
  kind: 'walkthrough-definition',
  id: 'tour:bakery-welcome',
  title: 'Welcome to the bakery',
  entry_step: 'step:counter',
  steps: [
    { id: 'step:counter', target_ref: { from: 'node-ref', parts: { page: 'menu' } }, content: { content_kind: 'card', payload: { title: 'The counter' } }, advance_condition: { op: 'target-interacted' } },
    { id: 'step:done', content: { content_kind: 'outcome', payload: { title: 'Done' } } },
  ],
  triggers: [{ reason: 'first-visit', on_event: { event_kind: 'shop-opened' }, once_key: 'tour:bakery-welcome' }],
};
const record = value => ({ address: `tour::${value.id}`, value_json: value });

test('tour records fold into the tours in force, carrying everything but id, entry and step ids as written', () => {
  const tours = foldTours([record(bakeryTour)]);
  const tour = tours['tour:bakery-welcome'];
  assert.deepEqual(tour.steps.map(step => step.id), ['step:counter', 'step:done']);
  assert.equal(tour.steps[0].content.content_kind, 'card');
  assert.deepEqual(tour.steps[0].advance_condition, { op: 'target-interacted' });
  assert.equal(tour.triggers.length, 1);
});

test('records may be stored text, a missing trigger list means none, a later record replaces, a deletion removes', () => {
  const bare = { kind: 'walkthrough-definition', id: 'tour:b', entry_step: 's1', steps: [{ id: 's1' }] };
  assert.deepEqual(foldTours([{ value_json: JSON.stringify(bare) }])['tour:b'].triggers, []);
  assert.deepEqual(foldTours([{ payload: bare }])['tour:b'].steps, [{ id: 's1' }]);
  assert.equal(foldTours([record(bakeryTour), record({ ...bakeryTour, title: 'v2' })])['tour:bakery-welcome'].title, 'v2');
  assert.equal(foldTours([record(bakeryTour), record({ id: 'tour:bakery-welcome', status: 'deleted' })])['tour:bakery-welcome'], undefined);
});

test('records that are not tours are skipped, and tours come back in id order', () => {
  const missingEntry = { kind: 'walkthrough-definition', id: 'tour:bad1', steps: [{ id: 's' }] };
  const badSteps = { kind: 'walkthrough-definition', id: 'tour:bad2', entry_step: 's', steps: 'nope' };
  const stepWithoutId = { kind: 'walkthrough-definition', id: 'tour:bad3', entry_step: 's', steps: [{}] };
  const other = { kind: 'something-else', id: 'x', entry_step: 's', steps: [{ id: 's' }] };
  assert.deepEqual(Object.keys(foldTours([missingEntry, badSteps, stepWithoutId, other, null, 'text'].map(value => ({ value_json: value })))), []);
  const mk = id => ({ kind: 'walkthrough-definition', id, entry_step: 's', steps: [{ id: 's' }] });
  assert.deepEqual(Object.keys(foldTours([record(mk('tour:z')), record(mk('tour:a'))])), ['tour:a', 'tour:z']);
});

test('an event starts the tour whose trigger fires, and a used-up key keeps it from starting again', () => {
  const tours = foldTours([record(bakeryTour)]);
  const hit = selectTourForEvent(tours, { event_kind: 'shop-opened' });
  assert.deepEqual([hit.tourId, hit.trigger.reason], ['tour:bakery-welcome', 'first-visit']);
  assert.equal(selectTourForEvent(tours, { event_kind: 'shop-opened' }, new Set(['tour:bakery-welcome'])), null);
});
