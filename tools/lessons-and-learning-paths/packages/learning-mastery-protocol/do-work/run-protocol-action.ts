import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { LearningMasteryProtocolDescriptor } from '../read-data/learning-mastery-types';

type Sender = typeof sendRequestToBitfieldTarget;

export async function runProtocolAction(
  descriptor: LearningMasteryProtocolDescriptor,
  actionKey: string,
  context: Record<string, unknown>,
  sender: Sender = sendRequestToBitfieldTarget,
): Promise<unknown> {
  const action = descriptor.actions[actionKey];
  if (!action?.target) throw new Error(`protocol action is unavailable: ${actionKey}`);
  console.info(`[learning-mastery] action dispatched key=${actionKey} target=${action.target}`);
  // The action payload is authored DATA that carries ONLY static routing/config
  // for the owner target (e.g. a workflow `operation`/`definition_id`). The
  // per-transition dynamic context (state_ref, expected_state_revision, from,
  // to, …) is delivered under a stable `input` key — the standard location an
  // owner (workflow execute_definition, or any slot) reads dynamic input from —
  // never spread across the payload namespace where it could collide with the
  // routing keys. Any static `input` defaults on the authored payload merge
  // first, then the live context overrides.
  const authored = (action.payload ?? {}) as Record<string, unknown>;
  const { input: authoredInput, ...routing } = authored;
  const staticInput = (authoredInput && typeof authoredInput === 'object')
    ? (authoredInput as Record<string, unknown>)
    : {};
  return sender({
    target: action.target,
    payload: { ...routing, input: { ...staticInput, ...context } },
  });
}
