import { readCapabilityDescriptors, readRedactionPolicies } from './capability-records';

export function readProviderReadinessView() {
  const descriptors = readCapabilityDescriptors();
  const policies = readRedactionPolicies();
  return {
    kind: 'provider-readiness-view',
    descriptor_count: descriptors.length,
    redaction_policy_count: policies.length,
    ready: descriptors.length > 0 && policies.length > 0,
    descriptor_ids: descriptors.map((descriptor) => descriptor.id),
  };
}
