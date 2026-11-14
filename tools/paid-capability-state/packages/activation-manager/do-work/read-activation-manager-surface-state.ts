import { resolveCallerContext } from './resolve-caller-context';
import { projectActivationCapabilityState } from '../read-data/read-activations';
import { readGateActivations } from '../read-data/read-gate-activations';

export async function readActivationManagerSurfaceState(input?: unknown) {
  const context = resolveCallerContext(input);
  if (!context.resolved || !context.subjectRef) {
    const projection = projectActivationCapabilityState([]);
    return {
      ...projection,
      problems: [
        ...projection.problems,
        {
          id: 'caller-context:missing',
          title: 'Caller context is missing',
          detail: context.reason,
        },
      ],
    };
  }
  return readGateActivations({ subjectRef: context.subjectRef });
}
