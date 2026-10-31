// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/do-work/run-after-saved-actions.test.ts.
// Changed from the package: a small recorder stands in for vitest's vi.fn, and node:assert supplies `rejects`
// (the Workshop's vitest shim has neither); every case and assertion is the package's.
import assert from 'node:assert/strict';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { runAfterSavedActions } from '../do-work/run-after-saved-actions.ts';
import type { QuestionSequence } from '../read-data/question-descriptor.ts';

function recorder() {
  const calls: Array<{ owner: string; actionRef: string; input: Record<string, unknown> }> = [];
  const dispatch = async (request: { owner: string; actionRef: string; input: Record<string, unknown> }) => {
    calls.push(request);
  };
  return { calls, dispatch };
}

function sequenceWith(
  owner: string,
  actionRef: string,
  input: Record<string, unknown>,
): QuestionSequence {
  return {
    formId: 'test-form',
    title: 'Test Form',
    questions: [{
      questionId: 'objective',
      questionTypeId: 'text',
      label: 'What are you working on?',
      afterSaved: { owner, actionRef, input },
    }],
  };
}

describe('runAfterSavedActions (owner-blind)', () => {
  it('dispatches whichever owner and actionRef the DATA names, without special-casing any package', async () => {
    const { calls, dispatch } = recorder();
    const sequence = sequenceWith('any-owner', 'action:whatever', {
      literal_string: 'unchanged',
      literal_number: 42,
      literal_bool: true,
      nested: { keep: 'as-is' },
      arr: [1, 'two', { three: 3 }],
    });

    const receipts = await runAfterSavedActions({
      answers: {},
      respondentId: 'account:1',
      sequence,
    }, dispatch);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      owner: 'any-owner',
      actionRef: 'action:whatever',
      input: {
        literal_string: 'unchanged',
        literal_number: 42,
        literal_bool: true,
        nested: { keep: 'as-is' },
        arr: [1, 'two', { three: 3 }],
      },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].owner).toBe('any-owner');
  });

  it('resolves every template token generically (scope_ref, run.id, now, now.epoch, uuid, answer)', async () => {
    const { calls, dispatch } = recorder();
    const fixedNow = new Date('2026-09-03T12:34:56.000Z');
    const sequence = sequenceWith('tasks', 'action:create-task', {
      task_id: '$uuid',
      title: '$answer.objective',
      scope: '$run.scope_ref',
      run: '$run.id',
      created_at: '$now',
      created_at_ms: '$now.epoch',
      passthrough: 'not-a-token',
    });

    await runAfterSavedActions({
      answers: { objective: 'Ship the release' },
      respondentId: 'account:9',
      runId: 'run:abc',
      sequence,
      now: fixedNow,
      newId: () => 'uuid-fixed',
    }, dispatch);

    expect(calls[0]).toEqual({
      owner: 'tasks',
      actionRef: 'action:create-task',
      input: {
        task_id: 'uuid-fixed',
        title: 'Ship the release',
        scope: 'account:9',
        run: 'run:abc',
        created_at: '2026-09-03T12:34:56.000Z',
        created_at_ms: fixedNow.getTime(),
        passthrough: 'not-a-token',
      },
    });
  });

  it('dispatches every hooked question in sequence order', async () => {
    const { calls, dispatch } = recorder();
    const sequence: QuestionSequence = {
      formId: 'multi',
      title: 'Multi',
      questions: [
        {
          questionId: 'first',
          questionTypeId: 'text',
          label: 'First',
          afterSaved: { owner: 'a', actionRef: 'action:first', input: { v: '$answer.first' } },
        },
        {
          questionId: 'middle',
          questionTypeId: 'text',
          label: 'Middle (no hook)',
        },
        {
          questionId: 'last',
          questionTypeId: 'text',
          label: 'Last',
          afterSaved: { owner: 'b', actionRef: 'action:last', input: { v: '$answer.last' } },
        },
      ],
    };

    await runAfterSavedActions({
      answers: { first: 'first-value', last: 'last-value' },
      respondentId: 'account:1',
      sequence,
    }, dispatch);

    expect(calls.map((call) => call.actionRef)).toEqual(['action:first', 'action:last']);
  });

  it('does nothing when no question declares afterSaved', async () => {
    const { calls, dispatch } = recorder();
    const receipts = await runAfterSavedActions({
      answers: {},
      respondentId: 'account:1',
      sequence: { formId: 'plain', title: 'Plain', questions: [] },
    }, dispatch);
    expect(receipts).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('fails closed when a template references a missing answer, before any dispatch', async () => {
    const { calls, dispatch } = recorder();
    const sequence = sequenceWith('tasks', 'action:create-task', {
      title: '$answer.missing',
    });
    await assert.rejects(runAfterSavedActions({
      answers: {},
      respondentId: 'account:1',
      sequence,
    }, dispatch), /\$answer\.missing/);
    expect(calls.length).toBe(0);
  });

  it('fails closed when $run.id is referenced but not provided', async () => {
    const { calls, dispatch } = recorder();
    const sequence = sequenceWith('tasks', 'action:create-task', {
      run: '$run.id',
    });
    await assert.rejects(runAfterSavedActions({
      answers: {},
      respondentId: 'account:1',
      sequence,
    }, dispatch), /\$run\.id/);
    expect(calls.length).toBe(0);
  });

  it('fails closed on any unknown $-prefixed token', async () => {
    const { calls, dispatch } = recorder();
    const sequence = sequenceWith('tasks', 'action:create-task', {
      weird: '$mystery.token',
    });
    await assert.rejects(runAfterSavedActions({
      answers: {},
      respondentId: 'account:1',
      sequence,
    }, dispatch), /Unknown afterSaved template token/);
    expect(calls.length).toBe(0);
  });
});
