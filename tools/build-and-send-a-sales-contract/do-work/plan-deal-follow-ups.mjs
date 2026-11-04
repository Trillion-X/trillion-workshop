// tools/build-and-send-a-sales-contract/do-work/plan-deal-follow-ups.mjs
//
// What a sent deal sets up afterwards: its follow-ups turned into the person's own rules (run when the deal is paid,
// for this deal only) and schedules (run once at a set time), by sales-contract-builder.mjs dealFollowUps over the
// paid trigger in ../sales-contract-builder.json. Words in braces in a step's input are filled only from the deal's
// facts ({to}, {contract_name}, {contract_id}, {address}); any other brace stays as written.
//
// Input:  { contract: { id, name }, facts: { to?, contract_name?, contract_id?, address? }, follow_ups: [step] }
//         step: { id?, label, on: "paid" | { once_at }, then: { tool_id | workflow_id, input } }
// Answer: { set: [{ kind: "rule" | "schedule", input }], offered: [{ id, label, on }] }
//         offered lists the follow-ups the builder offers (after_payment.steps), so a caller can choose from them.
// It sets nothing itself: the person's automations owner keeps each rule and schedule. Refuses a step with no tool or
// workflow, or with an `on` that is neither "paid" nor { once_at }.
import builder from '../sales-contract-builder.json' with { type: 'json' };
import { dealFollowUps } from './sales-contract-builder.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;

export function planDealFollowUps({ contract, facts = {}, follow_ups: followUps } = {}) {
  if (!contract || !text(contract.id) || !text(contract.name)) throw new Error('Give contract: { id, name } of the deal being sent.');
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('facts is { to, contract_name, contract_id, address }.');
  if (!Array.isArray(followUps)) throw new Error('Give follow_ups: a list of { label, on: "paid" | { once_at }, then: { tool_id, input } }.');
  const offered = (builder.after_payment?.steps ?? []).map(step => ({ id: step.id, label: step.label, on: step.on }));
  return { set: dealFollowUps({ contract, followUps, facts: { contract_name: contract.name, contract_id: contract.id, ...facts } }), offered };
}
