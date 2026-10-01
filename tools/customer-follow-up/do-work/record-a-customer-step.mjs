// tools/customer-follow-up/do-work/record-a-customer-step.mjs
//
// One step with a customer (outreach, a reply, a booked call, a purchase, onboarding, a follow-up, feedback) as the
// customer-step record to keep, with a fresh id, trimmed text and each reference once. Run by the Workshop tool
// `tool:record-a-customer-step` in the tool container:
//
//   node do-work/record-a-customer-step.mjs < <the input as JSON>
//
// and prints { step_id, step_record } as JSON on its last line. The Workshop keeps the record in the person's own
// records (the row's `keeps_records`), where see-where-each-customer-is reads it back.
import { text } from 'node:stream/consumers';
import { buildRecordCustomerStepInput } from './record-customer-step.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
console.log(JSON.stringify(buildRecordCustomerStepInput({
  contactId: input.contact_id,
  productId: input.product_id,
  stepKind: input.step,
  actorId: input.actor_id,
  label: input.label,
  outcome: input.outcome,
  evidenceRefs: input.evidence,
  ownerRefs: input.owners,
  ...(input.at ? { now: new Date(input.at) } : {}),
})));
