// package-set://bitfield-studio/packages/payment-adapter/do-work/materialize-operation-session-intent.ts

import {
  materializeOperationSessionIntent,
  type MaterializeOperationSessionIntentInput,
} from '../read-data/operation-routes.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function materializeOperationSessionIntentTarget(input: unknown) {
  return materializeOperationSessionIntent(record(input) as MaterializeOperationSessionIntentInput);
}
