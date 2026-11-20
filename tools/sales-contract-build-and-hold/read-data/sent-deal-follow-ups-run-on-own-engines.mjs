// A sent deal's follow-ups running on the person's own engines: a paid rule runs only for its own deal's payment, and a
// scheduled step runs once its time has come. Port of the behaviour the old builder test pinned (test/sales-contract-builder.test.mjs
// at 4ffa1dc4a2^). Storage-free: this decides what fires; the person's automations owner keeps the rules and schedules.
import data from './sent-deal-follow-ups-run-on-own-engines.json' with { type: 'json' };

/** The rule's "when" for a deal's paid follow-up: the paid trigger, narrowed to this deal's id. */
export function paidWhen(contractId) {
  return { ...data.paid_trigger, where: [...data.paid_trigger.where, { field: data.contract_field, equals: contractId }] };
}

/** True when a rule's "when" names this deal's id, so another deal's payment cannot run its steps. */
export function ruleCarriesDeal(rule, contractId) {
  return (rule.when?.where ?? []).some(test => test.field === data.contract_field && test.equals === contractId);
}

/** True when every test in a rule's "when" holds for the event. */
export function ruleFires(rule, event) {
  return (rule.when?.where ?? []).every(test => event[test.field] === test.equals);
}

/** True when a schedule's time has come by nowMs. */
export function scheduleIsDue(schedule, nowMs) {
  return Date.parse(schedule.once_at) <= nowMs;
}
