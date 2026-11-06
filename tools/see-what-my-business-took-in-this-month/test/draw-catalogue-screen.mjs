// A catalogue screen drawn as the engine's generic screen host draws it (trillion-rust src/tool_runs/page_routes.rs
// draw_layout, the one-to-one port of old trillion src/screen-layout.mjs drawLayout): its layout over the facts its
// reads answered, through the compiled formula evaluator (tools/formula-engine). Ported from old trillion
// test/catalogue-screens-for-tests.mjs drawCatalogueScreen and src/screen-layout.mjs, which it carries unchanged.
import { readFileSync } from 'node:fs';
import { loadRowEvaluator } from '../../formula-engine/rules/evaluate-over-rows.mjs';

export const catalogueRows = JSON.parse(readFileSync(new URL('../../show-my-screens-from-a-catalogue-of-reads-and-layouts/tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const evaluator = loadRowEvaluator(readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)));
const evaluate = (binding, input) => evaluator.evaluate(binding, input);

// old src/screen-layout.mjs, unchanged but for the evaluator passed in.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBinding = value => object(value) && value.$kind === 'binding';
const STRUCTURAL = new Set(['each', 'choose', 'join', 'apply']);

function resolvedArgs(value, context) {
  if (isBinding(value)) return evaluateBinding(value, context);
  if (object(value) && STRUCTURAL.has(value.$kind)) return drawLayout(value, context);
  if (Array.isArray(value)) return value.map(item => resolvedArgs(item, context));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvedArgs(item, context)]));
  return value;
}

function evaluateBinding(binding, context) {
  const transform = Array.isArray(binding.transform)
    ? binding.transform.map(step => (step.args === undefined ? step : { ...step, args: resolvedArgs(step.args, context) }))
    : binding.transform;
  return evaluate({ ...binding, ...(transform ? { transform } : {}) }, context) ?? null;
}

export function drawLayout(layout, context) {
  if (isBinding(layout)) return evaluateBinding(layout, context);
  if (Array.isArray(layout)) return layout.map(item => drawLayout(item, context)).filter(item => item !== null && item !== undefined);
  if (!object(layout)) return layout;
  if (layout.$kind === 'each') {
    const items = evaluateBinding(layout.of, context);
    if (items === null) return [];
    if (!Array.isArray(items)) throw new TypeError('A layout list must be read from a list.');
    return items.map((item, index) => drawLayout(layout.as, { ...context, item, index })).filter(item => item !== null && item !== undefined);
  }
  if (layout.$kind === 'choose') {
    const chosen = evaluateBinding(layout.when, context) === true ? layout.then : layout.else;
    return chosen === undefined ? null : drawLayout(chosen, context);
  }
  if (layout.$kind === 'apply') return evaluateBinding({ $kind: 'binding', select: { from: 'self', path: ['value'] }, transform: layout.transform },
    { ...context, value: drawLayout(layout.to, context) });
  if (layout.$kind === 'join') return layout.of.flatMap(part => {
    const drawn = drawLayout(part, context);
    return drawn === null ? [] : Array.isArray(drawn) ? drawn : [drawn];
  });
  const drawn = {};
  for (const [key, value] of Object.entries(layout)) {
    const placed = drawLayout(value, context);
    if (placed !== null && placed !== undefined) drawn[key] = placed;
  }
  return drawn;
}

/** Screen `toolId`'s description over `reads` ({ <read id>: what it answered, carried as JSON as a read's answer is }). */
export function drawCatalogueScreen(toolId, reads, { query = {}, browser = {} } = {}) {
  const screen = catalogueRows.find(row => row.id === toolId)?.screen;
  if (!screen) throw new Error(`No catalogue screen ${toolId}.`);
  return drawLayout(screen.layout, { query, browser, reads: JSON.parse(JSON.stringify(reads)) });
}
