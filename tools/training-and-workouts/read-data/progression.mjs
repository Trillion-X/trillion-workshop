// tools/training-and-workouts/read-data/progression.mjs
//
// Turns a person's stored progression rules and last result into the inputs a progress evaluator reads, and applies
// the adjustments an evaluator returned onto the session that was just done, giving the next session. The evaluation
// itself (which rule's band the measured value falls in) is not here: it is the evaluate-progress tool's job. A
// person's AI runs: read progression inputs here -> pick fired rules in evaluate-progress -> adapt the next session here.
// Pure and total: unknown adjustment keys are ignored, non-number dose and intensity values pass through, and the
// input prescription is never changed.

import { decodeTrainingPlan } from './training-plan.mjs';

const objectOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const textOf = value => (typeof value === 'string' ? value : '');
const finiteOf = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

// A stored row may be the record itself or wrap it in `payload` or `value`.
function payloadOf(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  return objectOf(row.payload ?? row.value ?? row);
}

const firstText = (row, ...keys) => { for (const key of keys) if (typeof row[key] === 'string') return row[key]; return ''; };

// Scales every finite number in a flat record by `factor`; whole numbers stay whole, others round to two places.
function scaleNumbers(record, factor) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const scaled = value * factor;
      out[key] = Number.isInteger(value) ? Math.round(scaled) : Math.round(scaled * 100) / 100;
    } else out[key] = value;
  }
  return out;
}

// ONE adjustment onto a prescription. `doseScale` / `intensityScale` multiply the numbers in dose / intensity; `note`
// is kept at intensity.note. A key that is absent leaves that part unchanged.
export function applyAdjustmentToPrescription(prescription, adjustment) {
  const doseScale = finiteOf(adjustment.doseScale);
  const intensityScale = finiteOf(adjustment.intensityScale);
  const note = typeof adjustment.note === 'string' ? adjustment.note : undefined;
  const dose = doseScale !== undefined ? scaleNumbers(prescription.dose, doseScale) : { ...prescription.dose };
  const intensity = intensityScale !== undefined ? scaleNumbers(prescription.intensity, intensityScale) : { ...prescription.intensity };
  if (note !== undefined) intensity.note = note;
  return { ...prescription, dose, intensity };
}

// Every adjustment in order. With none, the prescription comes back as an unchanged copy.
export function applyAdjustments(prescription, adjustments) {
  return (Array.isArray(adjustments) ? adjustments : []).reduce(
    (current, adjustment) => applyAdjustmentToPrescription(current, objectOf(adjustment)),
    applyAdjustmentToPrescription(prescription, {}),
  );
}

// ONE stored rule { id, applies_to, condition, adjustment } into { id, metricRef, band, adjustment, appliesTo?, label? }.
// The condition holds the metric and band flat ({ metricRef, min?, max? }) or nested ({ metricRef, band: { min?, max? } }),
// in camel or snake case. A rule with no metric reference is dropped (null), never guessed.
export function decodeProgressionRule(raw) {
  const row = payloadOf(raw);
  const condition = objectOf(row.condition);
  const metricRef = firstText(condition, 'metricRef', 'metric_ref') || firstText(row, 'metricRef', 'metric_ref');
  if (!metricRef) return null;
  const bandSource = condition.band !== undefined ? objectOf(condition.band) : condition;
  const min = finiteOf(bandSource.min);
  const max = finiteOf(bandSource.max);
  const appliesTo = firstText(row, 'appliesTo', 'applies_to');
  const label = firstText(row, 'label');
  return {
    id: firstText(row, 'id'),
    metricRef,
    band: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) },
    adjustment: objectOf(row.adjustment),
    ...(appliesTo ? { appliesTo } : {}),
    ...(label ? { label } : {}),
  };
}

// Rules as a list, or inside { rules: [...] }. Malformed rows are dropped; order is kept.
export function decodeProgressionRules(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rules) ? raw.rules : [];
  return rows.map(decodeProgressionRule).filter(Boolean);
}

// The measured result of the last session: which session, and its signals { metricRef, value } (camel or snake case).
// Null when there are no usable signals.
export function decodeLastResult(raw) {
  const root = objectOf(raw);
  const block = objectOf(root.lastResult ?? root.last_result);
  const sessionId = textOf(block.sessionId ?? block.session_id);
  const signals = (Array.isArray(block.signals) ? block.signals : []).flatMap(entry => {
    const row = objectOf(entry);
    const metricRef = textOf(row.metricRef ?? row.metric_ref);
    return metricRef && finiteOf(row.value) !== undefined ? [{ metricRef, value: row.value }] : [];
  });
  return signals.length ? { sessionId, signals } : null;
}

// The prescription a result belongs to: the named session, else the last session in the plan; null when there is none.
export function prescriptionFor(plan, sessionId) {
  const named = sessionId ? plan.sessions.find(session => session.id === sessionId) : undefined;
  return named ?? plan.sessions[plan.sessions.length - 1] ?? null;
}

// From the whole plan feed: the rules, the last result's signals and the prescription they belong to. With no usable
// result there are no signals and no prescription: nothing to adapt from, and nothing made up.
export function progressionInputs(feed) {
  const root = objectOf(feed);
  const rules = decodeProgressionRules(root.progressionRules ?? root.progression_rules ?? []);
  const last = decodeLastResult(feed);
  const prescription = last ? prescriptionFor(decodeTrainingPlan(feed), last.sessionId) : null;
  return { rules, signals: last?.signals ?? [], session_id: prescription?.id ?? '', prescription };
}
