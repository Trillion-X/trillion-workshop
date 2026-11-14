// tools/keep-records-as-long-as-their-keep-rule-says/read-data/keep-by-rule.mjs
//
// Purpose: The one tool a person's wake declaration names to apply a keep rule. A keep rule is a row of the person's own
// (the kind `record:keep-rule`: which kind of record, when a record of it has expired as the formula engine's rule tree over
// the record's own values and its age, how many records a firing may destroy and look at). The declaration's own schedule
// says when; this function answers the engine's keep effect for the rule the declaration names, and the engine reads the
// row, decides each record with the formula engine and destroys through its restorable erasure (trillion-rust src/wake.rs
// `Effect::Keep`, src/storage/record_store/keep.rs).
//
// Non-Negotiable Invariants:
//   1. This file counts no time, reads no record and removes none: it only hands the engine the rule's id, so every number
//      stays a column of the person's row and the schedule stays the person's declaration.
//   2. A call that names no rule answers an error and asks the engine for nothing.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import words from './keep-by-rule.json' with { type: 'json' };

/** { rule, resource? } -> { said, wake_effects: [{ keep: { resource, rule } }] } */
export function keepByRule(input = {}) {
  const rule = typeof input.rule === 'string' ? input.rule.trim() : '';
  if (!rule) throw new Error(words.no_rule);
  const resource = typeof input.resource === 'string' && input.resource.trim() ? input.resource.trim() : words.resource;
  return { said: words.said.replace('{rule}', rule).replace('{resource}', resource), wake_effects: [{ keep: { resource, rule } }] };
}
