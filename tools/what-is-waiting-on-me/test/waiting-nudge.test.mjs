import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWaitingNudge, waitingLongEnough, openOf } from '../from-old-trillion/src/waiting-nudge.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { whoDoesEachStep } from '../../say-for-each-step-of-a-plan-who-should-do/src/who-does-it.mjs';

const HOUR = 3_600_000;
const answerAt = at => ({ sections: [
  { id: 'voices', title: 'Whose voice is this?', cards: [{ id: 'voices:a', at: new Date(at - 3 * HOUR).toISOString() }, { id: 'voices:b', at: new Date(at - 1000).toISOString() }] },
  { id: 'decide', title: 'Decisions waiting on you', cards: [] },
] });

function rig(now) {
  let held = null; const told = [];
  const nudge = makeWaitingNudge({ read: async () => answerAt(now.at), tell: async n => { told.push(n); return { delivery_accepted: true }; }, kept: { read: () => held, write: v => { held = v; } }, alongside: async () => now.at + HOUR, settings, now: () => now.at });
  return { nudge, told, held: () => held };
}

test('only cards waiting past the wait time are nudged about', () => {
  const at = Date.parse('2026-10-05T12:00:00Z');
  const rows = waitingLongEnough(answerAt(at), settings.nudge, at);
  assert.deepEqual(rows.map(r => [r.section.id, r.cards.length]), [['voices', 1]]);
});

test('it tells the count and the rows, then waits its interval, and stops at the day cap', async () => {
  const now = { at: Date.parse('2026-10-05T08:00:00Z') };
  const { nudge, told } = rig(now);
  assert.equal(await nudge.nextAt(), now.at + HOUR);
  const first = await nudge.runDue();
  assert.deepEqual(first, { told: true, count: 1, rung: 'tell' });
  assert.equal(told[0].kind, 'needs-you');
  assert.equal(told[0].title, 'Waiting on you: 1');
  assert.match(told[0].body, /Whose voice is this\? \(1\)/);
  assert.equal(await nudge.nextAt(), now.at + settings.nudge.every_minutes * 60_000);
  for (let i = 1; i < 6; i += 1) { now.at += settings.nudge.every_minutes * 60_000; await nudge.runDue(); }
  const firstDay = told.filter((_, i) => i < settings.nudge.most_per_day + 1).length;
  assert.equal(told.length, 5, 'three on the first day, then the next day starts again');
  assert.ok(firstDay >= settings.nudge.most_per_day);
  assert.equal(new Set(told.map(n => n.key)).size, told.length);
});

test('nothing waiting tells nothing and then asks for no wake; something starting to wait asks again', async () => {
  let held = null;
  const at = Date.parse('2026-10-05T08:00:00Z');
  const nudge = makeWaitingNudge({ read: async () => ({ sections: [] }), tell: async () => assert.fail('told'), kept: { read: () => held, write: v => { held = v; } }, alongside: async () => null, settings, now: () => at });
  assert.equal(await nudge.nextAt(), at, 'never looked: one look on its own');
  assert.deepEqual(await nudge.runDue(), { told: false, count: 0 });
  assert.equal(await nudge.nextAt(), null, 'nothing waited and nothing else wakes the store');
  assert.equal(nudge.noteCount(2), true, 'something started to wait: arm again');
  assert.equal(nudge.noteCount(2), false);
  assert.equal(await nudge.nextAt(), at + settings.nudge.every_minutes * 60_000);
});

test('an addressed task arms the existing nudge without a screen read, and storage alone does not count as telling', async () => {
  let held = { count: 0 }, reads = 0;
  const at = Date.parse('2026-10-05T08:00:00Z');
  const nudge = makeWaitingNudge({ read: async () => { reads += 1; return answerAt(at); },
    tell: async () => ({ told: true, recorded: true, delivery_accepted: false, awareness: 'unknown' }),
    kept: { read: () => held, write: value => { held = value; } }, alongside: async () => null, settings, now: () => at });
  assert.equal(nudge.noteAtLeast(1), true);
  assert.equal(reads, 0);
  assert.equal(nudge.noteAtLeast(1), false);
  assert.equal((await nudge.runDue()).told, false);
  assert.equal(held.today.tell, 1, 'the cap still bounds attempts');
});

// The owner, 2026-10-06: "Hey, we are waiting on you", escalating until it's done, one tap to the exact thing, and only
// what truly needs him.
test('it gets louder the longer a thing waits, opens the thing itself, and ends the board when nothing waits', async () => {
  const start = Date.parse('2026-10-06T08:00:00Z');
  const now = { at: start };
  const card = { id: 'decisions:case-1', title: 'Reply to Mom', at: new Date(start - 3 * HOUR).toISOString(), address: 'https://app.gettrillion.ai/decisions/case-1', opens: { screen: 'trillion.decision' } };
  let waiting = [card];
  let held = null; const told = []; const reported = []; const taken = [];
  const nudge = makeWaitingNudge({
    read: async () => ({ sections: [{ id: 'decide', title: 'Decisions waiting on you', cards: waiting }] }),
    tell: async n => { told.push(n); return n; }, report: async r => { reported.push(r); return r; }, takeOver: async c => { taken.push(c.id); },
    kept: { read: () => held, write: v => { held = v; } }, alongside: async () => null, settings, now: () => now.at,
  });
  const first = await nudge.runDue();
  assert.equal(first.rung, 'tell');
  assert.equal(told[0].kind, 'needs-you');
  assert.equal(told[0].open, '/decisions/case-1', 'the notice opens the thing itself, not a list');
  assert.equal(told[0].refs.card, 'decisions:case-1', 'the notice names the thing, so an answer to it finishes that thing');
  assert.equal(reported.length, 0);
  now.at = start + 6 * HOUR;
  assert.equal((await nudge.runDue()).rung, 'board');
  assert.equal(told.at(-1).kind, 'needs-you-now');
  assert.match(told.at(-1).title, /Reply to Mom/);
  assert.equal(reported.at(-1).state, 'running');
  assert.equal(reported.at(-1).key, settings.nudge.board.key);
  assert.equal(reported.at(-1).body, 'Decisions waiting on you: Reply to Mom', 'the board says what kind of thing waits, never a bare name');
  assert.equal(await nudge.nextAt(), now.at + 120 * 60_000, 'the louder rung comes back sooner');
  now.at = start + 22 * HOUR;
  assert.equal((await nudge.runDue()).rung, 'take-over');
  assert.deepEqual(taken, ['decisions:case-1'], 'after a day the open page is taken to the thing');
  waiting = [];
  now.at += 2 * HOUR;
  const done = await nudge.runDue();
  assert.equal(done.told, false);
  assert.equal(reported.at(-1).state, 'done');
  assert.equal(reported.at(-1).kind, settings.nudge.board.ended_kind, 'the board ends quietly');
});

test('what Trillion can do is handed to the AIs instead of being put in the person\'s face', async () => {
  const at = Date.parse('2026-10-06T12:00:00Z');
  const old = new Date(at - 5 * HOUR).toISOString();
  const cards = [
    { id: 'asks:print', title: 'Print the shelf cards', needs: 'print labels', at: old },
    { id: 'asks:mom', title: 'Reply to Mom', needs: 'write', only_you_because: 'their-own-relationship', at: old },
    { id: 'asks:sign', title: 'Sign in to the bank', at: old },
  ];
  let held = null; const told = []; const handed = [];
  const nudge = makeWaitingNudge({
    read: async () => ({ sections: [{ id: 'asks', title: 'Your AIs need you to', cards }] }), tell: async n => { told.push(n); return n; },
    weigh: whoDoesEachStep, handOff: async job => { handed.push(job); return { handoff_id: 'h1' }; },
    kept: { read: () => held, write: v => { held = v; } }, alongside: async () => null, settings, now: () => at,
  });
  const answer = await nudge.runDue();
  assert.deepEqual(answer.handed, ['asks:print']);
  assert.equal(handed[0].once_per, 'weighed:asks:print');
  assert.match(handed[0].job, /tool:print/);
  assert.equal(answer.count, 2, 'only what truly needs the person is counted');
  assert.match(told[0].body, /\(2\)/);
});

test('a sign-in the AIs have not tried with a saved login goes to them, and reaches the person only after they were stopped', async () => {
  const at = Date.parse('2026-10-07T12:00:00Z');
  const old = new Date(at - 5 * HOUR).toISOString();
  const cards = [
    { id: 'asks:fb', title: 'Sign in to Facebook', reason_id: 'a-sign-in-only-they-can', at: old },
    { id: 'asks:fb-stopped', title: 'Sign in to the bank', reason_id: 'a-sign-in-only-they-can', tried_doer: 'sign-in-with-a-saved-login', at: old },
  ];
  let held = null; const handed = [];
  const nudge = makeWaitingNudge({
    read: async () => ({ sections: [{ id: 'asks', title: 'Your AIs need you to', cards }] }), tell: async n => n,
    weigh: whoDoesEachStep, handOff: async job => { handed.push(job); return { handoff_id: 'h2' }; },
    kept: { read: () => held, write: v => { held = v; } }, alongside: async () => null, settings, now: () => at,
  });
  const answer = await nudge.runDue();
  assert.deepEqual(answer.handed, ['asks:fb']);
  assert.equal(handed[0].once_per, 'weighed:asks:fb');
  assert.equal(answer.count, 1, 'only the sign-in the AIs were stopped on is in front of the person');
});

test('a link on Trillion\'s own origin opens inside Trillion; one elsewhere does not', () => {
  assert.equal(openOf({ opens: { link: 'https://app.gettrillion.ai/connections' }, address: 'https://app.gettrillion.ai/connections' }, settings.nudge.own_origins), '/connections');
  assert.equal(openOf({ opens: { link: 'sms:+15555550100' }, address: 'sms:+15555550100' }, settings.nudge.own_origins), null);
  assert.equal(openOf({ opens: { screen: 'trillion.decision' }, address: 'https://app.gettrillion.ai/decisions/x' }), '/decisions/x');
});

test('goesToAis names exactly the cards the hand-off takes, and asking hands none off', async () => {
  const at = Date.parse('2026-10-06T12:00:00Z');
  const old = new Date(at - 5 * HOUR).toISOString();
  const cards = [
    { id: 'asks:print', title: 'Print the shelf cards', needs: 'print labels', at: old },
    { id: 'asks:mom', title: 'Reply to Mom', needs: 'write', only_you_because: 'their-own-relationship', at: old },
    { id: 'asks:sign', title: 'Sign in to the bank', at: old },
  ];
  const answer = { sections: [{ id: 'asks', title: 'Your AIs need you to', cards }] };
  const make = handOff => makeWaitingNudge({ read: async () => answer, tell: async n => n, weigh: whoDoesEachStep, handOff, kept: { read: () => null, write: () => {} }, alongside: async () => null, settings, now: () => at });
  const handed = [];
  const nudge = make(async job => { handed.push(job); return { handoff_id: 'h3' }; });
  const predicted = await nudge.goesToAis(answer, settings.hold.after_minutes);
  assert.deepEqual(handed, [], 'asking calls no hand-off');
  const { handed: done } = await nudge.prepareForHold(answer, settings.hold.after_minutes);
  assert.deepEqual(predicted, ['asks:print']);
  assert.deepEqual(predicted, done, 'the ids are the ones weighing hands to the AIs');
  assert.deepEqual(handed.map(job => job.once_per), ['weighed:asks:print']);
  assert.deepEqual(await make(null).goesToAis(answer, settings.hold.after_minutes), [], 'with no hand-off configured, nothing goes to the AIs');
});
