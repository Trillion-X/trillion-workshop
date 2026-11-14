// Invocable package boundary for the application-composition primitive.
// It plans deterministic local writes and owner-addressed contribution
// operations. It performs no write itself; the package-owned dispatcher
// materializes the ordered delta, and the authorized writer applies that delta
// with expected-current/readback semantics.

import { planApplicationCompositionTransition } from '../read-data/application-composition';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function planApplicationCompositionTransitionTarget(input: unknown, _context?: unknown) {
  if (!isRecord(input)) throw new Error('application composition transition input must be an object');
  if (!Object.hasOwn(input, 'previous_composition')) throw new Error('previous_composition is required');
  if (!Object.hasOwn(input, 'next_composition')) throw new Error('next_composition is required');
  if (!isRecord(input.projector_template)) throw new Error('projector_template must be an object');
  if (!Array.isArray(input.previous_owner_descriptors)) throw new Error('previous_owner_descriptors must be an array');
  if (!Array.isArray(input.next_owner_descriptors)) throw new Error('next_owner_descriptors must be an array');
  return planApplicationCompositionTransition(
    input.previous_composition ?? undefined,
    input.next_composition ?? undefined,
    input.projector_template,
    input.previous_owner_descriptors,
    input.next_owner_descriptors,
  );
}
