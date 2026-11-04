// src/workshop-sample-rules.mjs
//
// PURPOSE
//   Where a tool runs decides how its own samples may run there: the rule of its placement's executor
//   (src/workshop-sample-rules.json). A tool that runs on the person's own computer may only carry samples that read or
//   rehearse, and a sample whose computer is not connected is owed, not failed (src/workshop.mjs sampleChecked).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No executor, placement or tool is named here: the rules are DATA rows keyed by the placement's executor.
//   2. A sample that does not declare a safety its rule allows never runs; a dry-run sample turns on the tool's own
//      boolean dry-run input.
//
import rules from '../../describe-the-workshop/read-data/workshop-sample-rules.json' with { type: 'json' };

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

/** The sample rule of the executor this placement names, or null when its samples run as any other. */
export const sampleRuleOf = (place, table = rules) => (place && Object.hasOwn(table.executors, place.executor) ? table.executors[place.executor] : null);

/** Why this sample may not run under `rule`, in words, or null when it may. */
export function unsafeSample(rule, tool, sample) {
  const values = { tool: tool.id, safe: rule.safe.join(' or '), field: rule.dry_run_field };
  if (!rule.safe.includes(sample?.safety)) return fill(rule.words.unsafe, values);
  if (sample.safety === 'dry-run' && (tool.input_schema?.properties?.[rule.dry_run_field]?.type !== 'boolean' || sample.input?.[rule.dry_run_field] !== true)) return fill(rule.words.dry_run, values);
  return null;
}
