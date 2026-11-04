import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

// A caller-level reference model: claims are exclusive, each retry fences older attempts, uncertain effects need a
// target check, and finished work is terminal. Queue selection and storage/index branches are intentionally absent.
const actors = ['a', 'b'];
const actions = [
  ...actors.map(actor => ({ type: 'take', actor })), { type: 'timeout' }, { type: 'reconcile' },
  ...actors.map(actor => ({ type: 'release', actor })), ...actors.map(actor => ({ type: 'finish', actor })),
  ...actors.map(actor => ({ type: 'effect-start', actor })),
  ...actors.flatMap(actor => ['done', 'failed'].map(outcome => ({ type: 'effect-settle', actor, outcome }))),
];
const initial = () => ({ phase: 'open', holder: null, generation: 0, lease: false, effect: 'none', effectGeneration: null, finishedBy: null });
const keyOf = state => JSON.stringify(state);

function step(before, action) {
  const after = { ...before };
  let result = 'unchanged';
  if (action.type === 'timeout') {
    if (after.phase === 'taken' && after.lease) { after.lease = false; result = 'timed-out'; }
  } else if (action.type === 'take') {
    if (after.phase === 'open' || (after.phase === 'taken' && !after.lease)) {
      Object.assign(after, { phase: 'taken', holder: action.actor, generation: after.generation + 1, lease: true, finishedBy: null });
      if (after.effect === 'starting') after.effect = 'unknown';
      result = 'taken';
    } else if (after.phase === 'taken' && after.lease && after.holder === action.actor) result = 'renewed';
  } else if (action.type === 'reconcile') {
    if (after.phase === 'taken' && !after.lease) {
      Object.assign(after, { phase: 'open', holder: null, lease: false });
      if (after.effect === 'starting') after.effect = 'unknown';
      result = 'reopened';
    }
  } else if (action.type === 'release') {
    if (after.phase !== 'taken' || after.holder !== action.actor) result = 'refused';
    else {
      Object.assign(after, { phase: 'open', holder: null, lease: false, finishedBy: null });
      if (after.effect === 'starting') after.effect = 'unknown';
      result = 'released';
    }
  } else if (action.type === 'finish') {
    if (after.phase === 'finished') result = after.finishedBy === action.actor ? 'repeated' : 'refused';
    else if (after.phase !== 'taken' || after.holder !== action.actor || ['starting', 'unknown'].includes(after.effect)) result = 'refused';
    else { Object.assign(after, { phase: 'finished', lease: false, finishedBy: action.actor }); result = 'finished'; }
  } else if (action.type === 'effect-start') {
    if (after.phase !== 'taken' || after.holder !== action.actor || !after.lease) result = 'refused';
    else if (after.effect === 'done' || after.effect === 'unknown') result = 'not-proceed';
    else if (after.effect === 'starting') result = 'proceed-again';
    else { after.effect = 'starting'; after.effectGeneration = after.generation; result = 'proceed'; }
  } else if (action.type === 'effect-settle') {
    if (after.phase !== 'taken' || after.holder !== action.actor || !after.lease) result = 'refused';
    else if (after.effect === action.outcome) result = 'repeated';
    else if (!['starting', 'unknown', 'failed'].includes(after.effect)) result = 'refused';
    else { after.effect = action.outcome; result = 'settled'; }
  } else throw new Error(`Unknown model action: ${action.type}`);
  return { after, result };
}

function explore(maxDepth = 7) {
  const root = initial();
  const states = new Map([[keyOf(root), { state: root, depth: 0 }]]);
  const edges = [];
  const queue = [root];
  while (queue.length) {
    const before = queue.shift();
    const depth = states.get(keyOf(before)).depth;
    if (depth === maxDepth) continue;
    for (const action of actions) {
      const transition = step(before, action);
      edges.push({ before, action, ...transition });
      const key = keyOf(transition.after);
      if (!states.has(key)) { states.set(key, { state: transition.after, depth: depth + 1 }); queue.push(transition.after); }
    }
  }
  return { states: [...states.values()].map(item => item.state), edges };
}

function canFinish(start) {
  // A constructive three-move recovery proves liveness without exploring unbounded retry generations: claim open or
  // expired work, settle any uncertain effect after checking its target, then finish the current attempt.
  let state = start;
  if (state.phase === 'open' || (state.phase === 'taken' && !state.lease)) state = step(state, { type: 'take', actor: 'a' }).after;
  if (state.phase === 'taken' && ['starting', 'unknown'].includes(state.effect))
    state = step(state, { type: 'effect-settle', actor: state.holder, outcome: 'done' }).after;
  if (state.phase === 'taken') state = step(state, { type: 'finish', actor: state.holder }).after;
  return state.phase === 'finished';
}

const iso = ms => new Date(ms).toISOString();
const expected = state => ({ phase: state.phase, holder: state.holder, generation: state.generation, effect: state.effect, finishedBy: state.finishedBy });
const observed = item => ({
  phase: item.state, holder: item.taken_by ?? null, generation: item.generation ?? 0,
  effect: item.effects?.find(effect => effect.effect_id === 'effect:one')?.state ?? 'none',
  finishedBy: item.state === 'finished' ? item.taken_by ?? null : null,
});

function seed(store, base, state, now, id) {
  const attempts = Array.from({ length: state.generation }, (_, index) => {
    const generation = index + 1;
    const active = generation === state.generation && state.phase === 'taken';
    return { attempt_id: `${id}:${generation}`, agent_id: active ? state.holder : 'a', generation,
      taken_at: iso(now - (active && state.lease ? 0 : 120_000)), hold_until: iso(now + (active && state.lease ? 60_000 : -60_000)),
      ended: active ? null : 'expired', ended_at: active ? null : iso(now) };
  });
  const effects = state.effect === 'none' ? {} : { 'effect:one': { effect_id: 'effect:one', target: 'test target', state: state.effect,
    generation: state.effectGeneration ?? state.generation, attempt_id: `${id}:${state.effectGeneration ?? state.generation}` } };
  store.putHandoff({ ...base, state: state.phase, taken_by: state.holder,
    taken_at: state.phase === 'taken' ? attempts.at(-1)?.taken_at : null,
    hold_until: state.phase === 'taken' ? attempts.at(-1)?.hold_until : null,
    finished_at: state.phase === 'finished' ? iso(now) : null, result: state.phase === 'finished' ? 'done' : null,
    generation: state.generation, attempts, effects, review_at: null, in_the_way: null, in_the_way_by: null,
    in_the_way_at: null, recovery: null, blocked_kind: null });
}

test('handoff generations, holds, finishes, and effect recovery match the bounded model', t => {
  const store = agentStoreForTests();
  let now = Date.parse('2026-10-06T12:00:00.000Z');
  const agents = makeAgents({ store, now: () => new Date(now) });
  for (const actor of actors) agents.publish({ agent_id: actor, name: actor.toUpperCase(), description: 'Takes work' });
  const created = agents.handOff({ job: 'Model-check handoff attempts', request_key: 'pat-83.2-model', hold_minutes: 1 }).handoff;
  const base = store.handoff(created.handoff_id);
  const { states, edges } = explore();
  assert.ok(states.length >= 25, `model walker visited only ${states.length} states`);
  assert.ok(edges.length >= 250, `model walker checked only ${edges.length} transitions`);
  t.diagnostic(`Model walker checked ${states.length} states and ${edges.length} transitions through depth 7.`);
  for (const state of states) if (state.phase !== 'finished') assert.ok(canFinish(state), `stuck model state: ${keyOf(state)}`);

  for (const { before, action, after, result } of edges) {
    now = Date.parse('2026-10-06T12:00:00.000Z');
    seed(store, base, before, now, base.handoff_id);
    const context = `${keyOf(before)} --${JSON.stringify(action)}--> ${keyOf(after)}`;
    if (action.type === 'timeout') {
      now += 120_000;
      assert.deepEqual(observed(agents.read({ handoff_id: base.handoff_id }).handoff), expected(after), context);
      continue;
    }
    let output;
    let error = null;
    try {
      if (action.type === 'take') output = agents.take({ agent_id: action.actor, handoff_id: base.handoff_id });
      else if (action.type === 'reconcile') output = agents.reconcile();
      else if (action.type === 'release') output = agents.release({ handoff_id: base.handoff_id, agent_id: action.actor, generation: before.generation });
      else if (action.type === 'finish') output = agents.finish({ handoff_id: base.handoff_id, agent_id: action.actor, generation: before.generation, result: 'done' });
      else if (action.type === 'effect-start') output = agents.recordEffect({ handoff_id: base.handoff_id, agent_id: action.actor, generation: before.generation, effect_id: 'effect:one', state: 'starting', target: 'test target' });
      else if (action.type === 'effect-settle') output = agents.recordEffect({ handoff_id: base.handoff_id, agent_id: action.actor, generation: before.generation, effect_id: 'effect:one', state: action.outcome, receipt: 'settled' });
    } catch (caught) { error = caught; }
    assert.equal(Boolean(error), result === 'refused', `${context}; modeled result=${result}; error=${error?.message ?? 'none'}`);
    if (action.type === 'take') {
      if (result === 'taken') assert.equal(output.handoff?.generation, after.generation, context);
      if (result === 'renewed') assert.equal(output.renewed, true, context);
      if (result === 'unchanged') assert.equal(output.handoff, null, context);
    }
    if (action.type === 'effect-start' && !error) assert.equal(output.proceed, ['proceed', 'proceed-again'].includes(result), context);
    if (action.type === 'reconcile' && result === 'reopened') assert.deepEqual(output.reopened, [base.handoff_id], context);
    const item = agents.read({ handoff_id: base.handoff_id }).handoff;
    assert.deepEqual(observed(item), expected(after), context);
    assert.equal(new Set(item.attempts.map(attempt => attempt.attempt_id)).size, item.attempts.length, `${context}; duplicate attempt id`);
    assert.equal(item.attempts.length, after.generation, `${context}; one attempt per generation`);
  }
});
