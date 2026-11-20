import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { invokeOperationTransition } from '../do-work/invoke-operation-transition.ts';
import type { OperationRecord, OperationTransition } from './operation-records.ts';

const operation = { id: 'work:correction-1' } as unknown as OperationRecord;
const transitionWith = (input: Record<string, unknown>) => ({
  id: 'transition:correct-1',
  ownerPackage: 'conversations',
  actionDefinitionId: 'correct',
  label: 'Correct',
  input,
}) as unknown as OperationTransition;

describe('a correction is carried by its handoff row, never by the retired runtime send', () => {
  it('resolves with the handoff ref and says the transition was not performed', async () => {
    const handoff = 'package::conversations::background-work-correction-handoff::turn:1';
    const answer = await invokeOperationTransition(operation, transitionWith({ correction_handoff_ref: handoff }));
    expect(answer).toEqual({ status: 'handed-off', performed: false, handoff_ref: handoff });
  });

  it('refuses a transition with no handoff to carry it, naming the transition', async () => {
    await expect(invokeOperationTransition(operation, transitionWith({}))).rejects.toThrow('transition:correct-1 has no correction handoff');
  });
});
