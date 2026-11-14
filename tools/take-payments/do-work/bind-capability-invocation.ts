import {
  bindCapabilityInvocation,
  type BindCapabilityInvocationInput,
} from '@/packages/stripe-payment-provider/read-data/capability-invocations';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function bindCapabilityInvocationTarget(input: unknown) {
  return bindCapabilityInvocation(record(input) as BindCapabilityInvocationInput);
}
