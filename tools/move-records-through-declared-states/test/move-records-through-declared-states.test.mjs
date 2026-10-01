// Vendored unchanged except for import paths from bitfield-packages/packages/move-records-through-declared-states/tests/a-record-moves-only-where-the-relation-allows.test.mjs.
// The fixture is the REAL eight records `activation-manager` writes at a package nobody built.
// Copied verbatim from `packages/activation-manager/things-to-store-and-run.json` lines 618 to 690,
// with no payload edited, because the migration claim in the plan is exactly that: these
// descriptors already fit and move across without being rewritten. A fixture invented for this
// package would prove the engine matches itself.
//
// Every test below is a way this could be wrong SILENTLY. A state machine that reports the wrong
// state does not throw, it sends the wrong email to a paying customer.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conditionHolds,
  currentState,
  moveIsAllowed,
  moveRecordFor,
  movesAvailable,
  reachableFrom,
  statesByKey,
  transitionsFrom,
  unreachableStates,
} from '../do-work/move-records-through-declared-states.mjs';

/** Verbatim from activation-manager. `track` is DATA, which is why one engine serves every track. */
const REAL_STATES = [
  { key: 'lead-new', label: "New, hasn't heard from us", tone: 'caution', rank: 20, terminal: false, track: 'lifecycle:relationship' },
  { key: 'paid-owes-welcome', label: 'Just paid, send them a welcome', tone: 'critical', rank: 10, terminal: false, track: 'lifecycle:relationship' },
  { key: 'onboarded', label: 'Welcomed and set up', tone: 'success', rank: 90, terminal: true, track: 'lifecycle:relationship' },
  { key: 'going-quiet', label: 'Slipping away, 14 days silent', tone: 'critical', rank: 15, terminal: false, track: 'lifecycle:relationship' },
];

/** The half that never existed anywhere: which moves are legal, and when. */
const REAL_TRANSITIONS = [
  { from: 'lead-new', to: 'paid-owes-welcome', when: { equals: { signal: 'payment_confirmed', value: true } } },
  { from: 'lead-new', to: 'going-quiet', when: { at_least: { signal: 'days_silent', value: 14 } } },
  { from: 'paid-owes-welcome', to: 'onboarded', when: { equals: { signal: 'welcome_sent', value: true } } },
  { from: 'going-quiet', to: 'paid-owes-welcome', when: { equals: { signal: 'payment_confirmed', value: true } } },
];

const built = () => {
  const states = statesByKey(REAL_STATES);
  return { states, transitions: transitionsFrom(REAL_TRANSITIONS, states) };
};

test('the real activation-manager descriptors load with no payload edit', () => {
  const { states, transitions } = built();
  assert.equal(states.size, 4);
  assert.equal(transitions.length, 4);
  assert.equal(states.get('onboarded').label, 'Welcomed and set up');
});

// THE HARM THE WHOLE PACKAGE EXISTS TO MAKE IMPOSSIBLE.
//
// Under band membership, `onboarded` is just the band for a high signal, so a paying customer who
// goes quiet recomputes into `going-quiet` and is welcomed a second time. Two assertions, because
// the edge must be impossible to DECLARE as well as impossible to TAKE: if only the second held,
// the relation would carry a lie that every reader inherits.
test('a terminal state may not be left, and the edge may not even be declared', () => {
  const { states, transitions } = built();

  assert.deepEqual(
    moveIsAllowed({ states, transitions, from: 'onboarded', to: 'going-quiet', signals: { days_silent: 400 } }),
    { allowed: false, reason: '"onboarded" is terminal, so this record does not move again' },
  );

  assert.throws(
    () => transitionsFrom([...REAL_TRANSITIONS, { from: 'onboarded', to: 'going-quiet' }], states),
    /terminal and cannot have an outgoing transition/,
    'declaring the edge must fail at read time, once, not per record',
  );
});

test('a move the relation does not contain is refused, and says which move', () => {
  const { states, transitions } = built();
  assert.deepEqual(
    moveIsAllowed({ states, transitions, from: 'lead-new', to: 'onboarded', signals: { welcome_sent: true } }),
    { allowed: false, reason: 'no declared transition goes from "lead-new" to "onboarded"' },
  );
});

// The distinction a boolean destroys. "No edge" is a design gap somebody must fix; "condition not
// met" is ordinary waiting. Collapsing them sends people to fix a machine that is working.
test('an unmet condition is refused DIFFERENTLY from a missing edge', () => {
  const { states, transitions } = built();
  const notYet = moveIsAllowed({ states, transitions, from: 'lead-new', to: 'paid-owes-welcome', signals: { payment_confirmed: false } });
  assert.equal(notYet.allowed, false);
  assert.equal(notYet.reason, 'the declared condition is not met');
  assert.notEqual(notYet.reason, 'no declared transition goes from "lead-new" to "paid-owes-welcome"');
});

test('a legal move with its condition met is allowed', () => {
  const { states, transitions } = built();
  assert.deepEqual(
    moveIsAllowed({ states, transitions, from: 'lead-new', to: 'paid-owes-welcome', signals: { payment_confirmed: true } }),
    { allowed: true, reason: null },
  );
});

test('movesAvailable reports the refused options too, with reasons', () => {
  const { states, transitions } = built();
  const options = movesAvailable({ states, transitions, from: 'lead-new', signals: { payment_confirmed: true, days_silent: 2 } });
  assert.deepEqual(options, [
    { to: 'paid-owes-welcome', allowed: true, reason: null },
    { to: 'going-quiet', allowed: false, reason: 'the declared condition is not met' },
  ]);
});

// An absent signal must not satisfy a threshold in EITHER direction. Returning 0 for a missing
// measurement would make `at_most` true, so a record nobody has measured would satisfy "quiet for
// at most 14 days" and move, which is the reading a caller would least expect from missing data.
test('an absent or non-numeric signal satisfies neither at_least nor at_most', () => {
  assert.equal(conditionHolds({ at_least: { signal: 'days_silent', value: 14 } }, {}), false);
  assert.equal(conditionHolds({ at_most: { signal: 'days_silent', value: 14 } }, {}), false);
  assert.equal(conditionHolds({ at_most: { signal: 'days_silent', value: 14 } }, { days_silent: 'four' }), false);
  assert.equal(conditionHolds({ absent: 'days_silent' }, {}), true, 'and absent is how a caller says it deliberately');
  assert.equal(conditionHolds({ absent: 'days_silent' }, { days_silent: 3 }), false);
});

test('an unrecognised condition shape throws rather than evaluating false', () => {
  // Quietly false would make a transition permanently unreachable and look exactly like a
  // correctly restrictive relation, which is the least debuggable failure this file could have.
  assert.throws(() => conditionHolds({ greater_than: { signal: 'x', value: 1 } }, { x: 5 }), /unrecognised condition/);
});

test('current state is the last move, and a record with no moves is at the start', () => {
  const { states } = built();
  assert.equal(currentState([], states, 'lead-new'), 'lead-new');
  assert.equal(
    currentState([{ from: 'lead-new', to: 'paid-owes-welcome', at: '2026-09-05T10:00:00Z' }], states, 'lead-new'),
    'paid-owes-welcome',
  );
});

test('history alone determines where a record is, with no stored status field', () => {
  const { states } = built();
  const history = [
    { from: 'lead-new', to: 'going-quiet', at: '2026-08-01T00:00:00Z' },
    { from: 'going-quiet', to: 'paid-owes-welcome', at: '2026-09-01T00:00:00Z' },
    { from: 'paid-owes-welcome', to: 'onboarded', at: '2026-09-02T00:00:00Z' },
  ];
  assert.equal(currentState(history, states, 'lead-new'), 'onboarded');
});

test('a start state nobody declared throws, rather than leaving a record in no state', () => {
  const { states } = built();
  assert.throws(() => currentState([], states, 'prospect'), /start state "prospect" is not declared/);
});

test('a transition naming an undeclared state throws and lists what IS declared', () => {
  const { states } = built();
  assert.throws(
    () => transitionsFrom([{ from: 'lead-new', to: 'onboarded-typo' }], states),
    /to "onboarded-typo" names no declared state\. Declared: lead-new, paid-owes-welcome, onboarded, going-quiet/,
  );
});

test('two descriptors for one state key throw, rather than one silently winning', () => {
  assert.throws(
    () => statesByKey([...REAL_STATES, { key: 'onboarded', label: 'A second opinion', terminal: false }]),
    /two state descriptors declare the key "onboarded"/,
  );
});

test('building a move record refuses an illegal one instead of flagging it', () => {
  const { states, transitions } = built();
  assert.throws(
    () => moveRecordFor({ states, transitions, from: 'lead-new', to: 'onboarded', signals: {}, at: '2026-09-05T00:00:00Z' }),
    /refused: no declared transition/,
  );

  assert.deepEqual(
    moveRecordFor({
      states, transitions, from: 'lead-new', to: 'paid-owes-welcome',
      signals: { payment_confirmed: true }, at: '2026-09-05T00:00:00Z', because: 'stripe webhook',
    }),
    { from: 'lead-new', to: 'paid-owes-welcome', at: '2026-09-05T00:00:00Z', because: 'stripe webhook' },
  );
});

test('a move with no caller-supplied time is refused, because this file reads no clock', () => {
  const { states, transitions } = built();
  assert.throws(
    () => moveRecordFor({ states, transitions, from: 'lead-new', to: 'paid-owes-welcome', signals: { payment_confirmed: true } }),
    /reads no clock/,
  );
});

// The state-machine twin of the dead address that produced this package: a descriptor with a label
// and a tone that no path leads to renders in every picker and is chosen by nobody forever.
test('a state no path reaches is reported, and the real four are all reachable', () => {
  const { states, transitions } = built();
  assert.deepEqual(unreachableStates(states, transitions, 'lead-new'), []);

  const withOrphan = statesByKey([...REAL_STATES, { key: 'refunded', label: 'Refunded', terminal: true }]);
  assert.deepEqual(
    unreachableStates(withOrphan, transitionsFrom(REAL_TRANSITIONS, withOrphan), 'lead-new'),
    ['refunded'],
  );
});

test('reachability ignores conditions, because it asks about the design and not about a record', () => {
  const { transitions } = built();
  // going-quiet is reachable even though no record has been silent long enough yet.
  assert.deepEqual([...reachableFrom(transitions, 'lead-new')].sort(), ['going-quiet', 'lead-new', 'onboarded', 'paid-owes-welcome']);
});

test('a cycle in the relation terminates instead of hanging', () => {
  // going-quiet returns to paid-owes-welcome, which is a real cycle in the real data. A
  // breadth-first walk that forgot its seen-set would run forever here, and a hang in a checker is
  // reported by a human as "it stopped working" with no error to search for.
  const { transitions } = built();
  assert.equal(reachableFrom(transitions, 'going-quiet').has('onboarded'), true);
});

// The whole point of the package, stated as one assertion a reader can check in five seconds.
test('the engine names no domain word anywhere in its source', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../do-work/move-records-through-declared-states.mjs', import.meta.url), 'utf8');
  const executable = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  for (const domainWord of ['lead', 'onboard', 'customer', 'payment', 'welcome', 'quiet', 'lifecycle', 'poker', 'plan']) {
    assert.doesNotMatch(
      executable,
      new RegExp(domainWord, 'i'),
      `the engine must not name "${domainWord}"; states arrive as DATA or not at all`,
    );
  }
});
