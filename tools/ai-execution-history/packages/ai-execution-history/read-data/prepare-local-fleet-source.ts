import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  localActorAdmittedWrapper,
  type AdmissionRecipe,
} from '../../../../ui/show/action-affordance/local-actor-admission';

type Dispatch = (request: { target: string; payload: Record<string, unknown> }) => Promise<unknown>;

const TARGET = 'ai-execution-history.prepare-local-fleet-source';
const recipe: AdmissionRecipe = {
  action_ref: TARGET,
  authorized_action_refs: [TARGET],
  constraints: {},
  predicate_ref: 'predicate:authenticated-session',
  predicate_binding: { $kind: 'binding', select: { from: 'literal', value: true } },
  subject_binding: { $kind: 'binding', select: { from: 'context', path: 'payload.source_ref' } },
  resource_revision_binding: { $kind: 'binding', select: { from: 'context', path: 'payload.source_ref' } },
};

export async function prepareLocalFleetSource(
  sourceRef: string,
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(sourceRef) || sourceRef.includes('::')) {
    throw new Error('The local session source is invalid.');
  }
  const admitted = await localActorAdmittedWrapper({
    target: TARGET,
    payload: { source_ref: sourceRef },
    recipe,
    dispatch,
  });
  return dispatch({ target: TARGET, payload: admitted });
}
