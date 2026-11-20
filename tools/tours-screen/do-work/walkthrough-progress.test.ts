// The outcomes of the package's progress-transition tests (progress-transition-owner.test.ts.held and
// scoped-run-progress.contract.test.ts.held), over the pure move that is live now: applyProgressTransition in
// walkthrough-progress.ts. The package's version sent each move to a package-runtime owner target and kept one row per
// scope and run; the Workshop keeps one record per person with a cursor per tour, so a case that named the owner
// target, its wire, its native hash, its address by scope or its aggregate-shape migration has no live twin (the
// research row verify-every-port/tours-screen says which, and why).
import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { foldWalkthroughProgress } from '../read-data/walkthrough-eeaf.ts';
import {
  applyProgressTransition,
  readProgressRecord,
  type ProgressTransitionRequest,
} from './walkthrough-progress.ts';

const NOW = '2026-01-10T12:00:00.000Z';
const LATER = '2026-01-11T12:00:00.000Z';

function request(overrides: Partial<ProgressTransitionRequest> = {}): ProgressTransitionRequest {
  return {
    run_id: 'run-1',
    definition_id: 'walkthrough-1',
    definition_revision: 1,
    expected_cursor_revision: 0,
    from_step_id: 'one',
    to_step_id: 'two',
    history: ['one'],
    status: 'active',
    cause: 'advance',
    ...overrides,
  };
}

describe('progress transition (the live move)', () => {
  it.each([undefined, null, [], 0, false, 'saved progress'])('reads an unreadable saved record as an empty one: %j', (saved) => {
    expect(readProgressRecord(saved)).toEqual({
      kind: 'walkthrough-progress', consumed_once_keys: [], consumed_at: {}, cursors: {}, transitions: [],
    });
  });

  it('persists a replayable cursor transition and deduplicates the same request', () => {
    const first = applyProgressTransition(undefined, request(), NOW);
    expect(first.receipt).toMatchObject({ accepted: true, deduplicated: false, cursor_revision: 1 });
    expect(first.state.transitions).toHaveLength(1);
    const duplicate = applyProgressTransition(first.state, request(), LATER);
    expect(duplicate.receipt).toMatchObject({ accepted: true, deduplicated: true, cursor_revision: 1 });
    expect(duplicate.state.transitions).toHaveLength(1);
  });

  it('rejects a stale transition so an older browser cannot regress the cursor', () => {
    const first = applyProgressTransition(undefined, request(), NOW);
    const stale = applyProgressTransition(first.state, request({ to_step_id: 'older' }), NOW);
    expect(stale.receipt).toMatchObject({ accepted: false, reason: 'stale-cursor', cursor_revision: 1 });
    expect(stale.state.cursors['walkthrough-1']).toMatchObject({ current_step_id: 'two', cursor_revision: 1 });
  });

  it('answers a move from the wrong step as a mismatch and changes nothing', () => {
    const first = applyProgressTransition(undefined, request(), NOW);
    const wrong = applyProgressTransition(first.state, request({ expected_cursor_revision: 1, from_step_id: 'elsewhere', to_step_id: 'three' }), NOW);
    expect(wrong.receipt).toMatchObject({ accepted: false, reason: 'cursor-mismatch', current_step_id: 'two' });
    expect(wrong.state).toEqual(first.state);
  });

  it('keeps skip completion distinct from a step and stores the authored trigger key with when it was consumed', () => {
    const skipped = applyProgressTransition(undefined, request({
      to_step_id: 'one', history: [], status: 'complete', once_key: 'trigger-1',
    }), NOW);
    expect(skipped.state.consumed_once_keys).toEqual(['trigger-1']);
    expect(skipped.state.consumed_at).toEqual({ 'trigger-1': NOW });
    expect(skipped.receipt.status).toBe('complete');
    expect(skipped.state.cursors['walkthrough-1']).toMatchObject({ status: 'complete', current_step_id: 'one' });
  });

  it('consumes the tours a catch-up tour stood for in the same write, and keeps the first time a key was consumed', () => {
    const first = applyProgressTransition(undefined, request({ status: 'complete', once_key: 'k-main', also_once_keys: ['k-other'] }), NOW);
    expect(first.state.consumed_once_keys).toEqual(['k-main', 'k-other']);
    const again = applyProgressTransition(first.state, request({
      run_id: 'run-2', status: 'complete', once_key: 'k-main', also_once_keys: ['k-third'],
    }), LATER);
    expect(again.state.consumed_once_keys).toEqual(['k-main', 'k-other', 'k-third']);
    expect(again.state.consumed_at['k-main']).toBe(NOW);
    expect(again.state.consumed_at['k-third']).toBe(LATER);
  });

  it('allows a new run to replay after terminal history, with its own cursor', () => {
    const terminal = applyProgressTransition(undefined, request({ status: 'complete', to_step_id: 'one' }), NOW);
    const replay = applyProgressTransition(terminal.state, request({ run_id: 'run-2', from_step_id: 'one', to_step_id: 'two' }), NOW);
    expect(replay.receipt).toMatchObject({ accepted: true, run_id: 'run-2', cursor_revision: 1 });
    expect(replay.state.transitions).toHaveLength(2);
  });

  it('keys a cursor by the tour and its run: another tour moves on its own', () => {
    const one = applyProgressTransition(undefined, request({ run_id: 'run-key', definition_revision: 7 }), NOW);
    const other = applyProgressTransition(one.state, request({ definition_id: 'walkthrough-2', run_id: 'run-other' }), NOW);
    expect(other.receipt.accepted).toBe(true);
    expect(other.state.cursors['walkthrough-1']).toMatchObject({ run_id: 'run-key', definition_revision: 7 });
    expect(other.state.cursors['walkthrough-2']).toMatchObject({ run_id: 'run-other', cursor_revision: 1 });
  });

  it('keeps only the recent moves it needs to answer a repeat', () => {
    let state: unknown;
    for (let index = 0; index < 40; index += 1) {
      state = applyProgressTransition(state, request({
        expected_cursor_revision: index, from_step_id: `s${index}`, to_step_id: `s${index + 1}`, history: [],
      }), NOW).state;
    }
    expect((state as { transitions: unknown[] }).transitions).toHaveLength(32);
  });

  it('is read back by the fold the host starts from: the cursor, its run and the consumed keys', () => {
    const progressed = applyProgressTransition(undefined, request({ status: 'complete', to_step_id: 'two', once_key: 'k-done' }), NOW).state;
    const folded = foldWalkthroughProgress([
      { address: 'foreign', value_json: { kind: 'something-else', consumed_once_keys: ['not-ours'] } },
      { address: 'progress', value_json: progressed },
    ]);
    expect(folded.cursors['walkthrough-1']).toMatchObject({ currentStepId: 'two', cursorRevision: 1, definitionRevision: 1, runId: 'run-1', status: 'complete' });
    expect([...folded.consumedOnceKeys]).toEqual(['k-done']);
    expect(folded.consumedAt.get('k-done')).toBe(NOW);
  });
});
