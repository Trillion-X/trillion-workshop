import { mapCapabilityRequest } from '../../shared-code/src/provider-request-mapper.mjs';
import { redactStripeResponse } from '../do-work/stripe-response-redactor.mjs';
// Re-exported so existing importers (tests) keep `readCliInput` from this module.
export { readCliInput } from './read-cli-input.mjs';
import { readCliInput } from './read-cli-input.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function buildDryRunReceipt(input) {
  const mapped = mapCapabilityRequest(input);
  const objectRef = input?.input_facts?.provider_object_ref?.ref || `provider-object:${input?.idempotency_key || 'dry-run'}`;
  return redactStripeResponse({
    provider_request_id: `request:${input?.idempotency_key || 'dry-run'}`,
    observed_state: 'request-mapped',
    public_handoff_url: mapped.hands_the_person_off ? 'https://checkout.stripe.com/c/session_redacted' : undefined,
    provider_object_refs: [{ ref: objectRef, object_type: mapped.operation_id || 'provider-object' }],
    mapped_request: mapped,
  });
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const input = readCliInput(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(buildDryRunReceipt(input))}\n`);
}
