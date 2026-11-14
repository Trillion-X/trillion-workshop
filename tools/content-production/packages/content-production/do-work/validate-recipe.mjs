/**
 * file: packages/content-production/do-work/validate-recipe.mjs
 *
 * PURPOSE: Conformance validator proving a recipe is a valid NATIVE
 * workflow-definition record (plan §7/T01, recipe-conformance.md). It validates
 * the engine's EXISTING shape — it defines no new orchestration format.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The step-kind vocabulary below is the engine's observed live vocabulary —
 *    extending the engine extends this list, never the reverse
 * 2. A `steps` binding may only reference an EARLIER step (no forward/cyclic deps)
 * 3. ask steps carry the descriptor under config.input — config.process_descriptor
 *    is the Round-6 finding-4 bug and is rejected by name
 * 4. Pure: no I/O, no engine calls — input object in, findings out
 */

// The engine's live step vocabulary (census across every package definition).
const STEP_KINDS = new Set(['action', 'ask', 'read', 'write', 'loop', 'return']);
// Live binding sources (census).
const BINDING_SOURCES = new Set(['input', 'steps', 'context', 'loop', 'transcript-sources']);

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Walk a value collecting every `$kind:"binding"` object with its JSON path.
 */
function collectBindings(value, path, found) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectBindings(entry, `${path}[${index}]`, found));
    return;
  }
  if (!isRecord(value)) return;
  if (value.$kind === 'binding') found.push({ binding: value, path });
  for (const [key, child] of Object.entries(value)) {
    if (key === '$kind') continue;
    collectBindings(child, `${path}.${key}`, found);
  }
}

/**
 * Validate one recipe (a workflow-definition record payload).
 * Returns { ok: boolean, findings: string[] } — findings are exact, actionable sentences.
 */
export function validateRecipe(payload) {
  const findings = [];

  if (!isRecord(payload)) {
    return { ok: false, findings: ['payload is not an object'] };
  }
  if (payload.kind !== 'action') findings.push(`payload.kind must be "action", got ${JSON.stringify(payload.kind)}`);
  if (!isNonEmptyText(payload.id)) findings.push('payload.id is required (e.g. "action:style-talking-head")');
  else if (!payload.id.startsWith('action:')) findings.push(`payload.id must start with "action:", got "${payload.id}"`);
  if (!isNonEmptyText(payload.name)) findings.push('payload.name is required');
  // `partition_key` is NOT validated here, and must not be re-added. It is assigned by the engine
  // from the dispatch partition (workflow definition_query.rs, the sole writer), so an authored
  // value is read and discarded. Requiring it here made this package fail its own conformance rule
  // once its recipes stopped authoring the field, proven by two suites asserting an empty findings
  // list and getting `payload.partition_key is required`.

  const steps = payload.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    findings.push('payload.steps must be a non-empty array');
    return { ok: findings.length === 0, findings };
  }

  const seenStepIds = new Set();
  steps.forEach((step, index) => {
    const where = `steps[${index}]${isNonEmptyText(step?.id) ? ` (id "${step.id}")` : ''}`;
    if (!isRecord(step)) {
      findings.push(`${where} is not an object`);
      return;
    }
    if (!STEP_KINDS.has(step.kind)) {
      findings.push(`${where} kind ${JSON.stringify(step.kind)} is not an engine step kind (${[...STEP_KINDS].join(', ')})`);
    }
    const config = isRecord(step.config) ? step.config : null;

    if (step.kind === 'action') {
      if (!isNonEmptyText(config?.definition_id)) {
        findings.push(`${where} action step requires config.definition_id ("action:<x>")`);
      } else if (!config.definition_id.startsWith('action:')) {
        findings.push(`${where} config.definition_id must start with "action:" — there is no "capability:" resolver`);
      }
    }
    if (step.kind === 'ask') {
      if (!isNonEmptyText(config?.name)) findings.push(`${where} ask step requires config.name (e.g. "compute.process")`);
      if (config && 'process_descriptor' in config) {
        findings.push(`${where} ask step config key must be "input", not "process_descriptor" (Round-6 finding 4)`);
      }
    }

    // Bindings inside this step: structural shape + no forward step references.
    const bindings = [];
    collectBindings(step, where, bindings);
    for (const { binding, path } of bindings) {
      const select = binding.select;
      if (!isRecord(select) || !isNonEmptyText(select.from)) {
        findings.push(`${path} binding requires select.from`);
        continue;
      }
      if (!BINDING_SOURCES.has(select.from)) {
        findings.push(`${path} binding select.from ${JSON.stringify(select.from)} is not a live source (${[...BINDING_SOURCES].join(', ')})`);
      }
      if (select.from === 'steps') {
        if (!isNonEmptyText(select.key)) {
          findings.push(`${path} steps binding requires select.key naming an earlier step id`);
        } else if (!seenStepIds.has(select.key)) {
          findings.push(`${path} steps binding references "${select.key}" which is not an EARLIER step — forward/cyclic dependencies are invalid`);
        }
      }
    }

    // The engine addresses every step BOTH by its explicit id (when present)
    // and by its implicit positional key "step_<index>" (live definitions
    // without ids — e.g. action:run-publish-intent — bind via "step_0").
    if (isNonEmptyText(step.id)) seenStepIds.add(step.id);
    seenStepIds.add(`step_${index}`);
  });

  // Zero closed vocabularies: input_schema must not enumerate styles/capabilities/platforms.
  const schemaText = JSON.stringify(payload.input_schema ?? {});
  if (/"enum"\s*:/.test(schemaText)) {
    findings.push('input_schema contains an enum — recipes carry zero closed vocabularies (L090)');
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Validate a full boundary record (type/address/path wrapper + payload).
 */
export function validateRecipeRecord(record) {
  const findings = [];
  if (!isRecord(record)) return { ok: false, findings: ['record is not an object'] };
  const path = record.path;
  const expected = ['current-item', 'published-record', 'workflow-definition'];
  if (!Array.isArray(path) || expected.some((segment, index) => path[index] !== segment)) {
    findings.push(`record.path must be ${JSON.stringify(expected)}, got ${JSON.stringify(path)}`);
  }
  const payloadResult = validateRecipe(record.payload);
  findings.push(...payloadResult.findings);
  const ok = findings.length === 0;
  console.log(`[recipe.validate] def=${record?.payload?.id ?? '?'} steps=${record?.payload?.steps?.length ?? 0} ${ok ? 'OK' : `REJECT ${findings[0]}`}`);
  return { ok, findings };
}
