// src/screen-layout.mjs
//
// PURPOSE
//   A screen's layout drawn from what its reads answered (src/screen-host.mjs, a catalogue row's
//   screen: { kind: "reads", reads, layout }). The layout is DATA: the screen's description with values that are
//   formula-engine bindings ({ $kind: "binding", select, transform }, parts/formula-engine), evaluated by the one
//   compiled evaluator (src/formula-evaluate.mjs) against the screen's context ({ reads, query, browser, item, index }).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every computed value is a formula-engine binding; this walker only places what the evaluator answers. It adds
//      four structural nodes the evaluator cannot express over a whole description:
//        { $kind: "each", of: <binding>, as: <layout> }     one copy of `as` per item of the list `of` answers, each
//                                                            evaluated with { item, index } added to the context;
//        { $kind: "choose", when: <binding>, then, else }    `then` when `when` answers true, else `else`;
//        { $kind: "join", of: [<layout>, ...] }              the lists the parts answer, one after another;
//        { $kind: "apply", to: <layout>, transform: [...] }  a binding's transform run over what `to` draws (a list of
//                                                            words joined into one line, say).
//   2. A binding's transform arguments may themselves be bindings or structural nodes; they are evaluated first, against
//      the same context, so a value can be built from several facts.
//   3. A field whose value is null (or missing) is left out of the description, as an absent field.
//   4. Nothing here names a screen, a read or a field.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBinding = value => object(value) && value.$kind === 'binding';
const STRUCTURAL = new Set(['each', 'choose', 'join', 'apply']);

/** Every binding and structural node inside a transform's arguments replaced by its value in `context`. */
function resolvedArgs(value, context, evaluate) {
  if (isBinding(value)) return evaluateBinding(value, context, evaluate);
  if (object(value) && STRUCTURAL.has(value.$kind)) return drawLayout(value, context, evaluate);
  if (Array.isArray(value)) return value.map(item => resolvedArgs(item, context, evaluate));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvedArgs(item, context, evaluate)]));
  return value;
}

function evaluateBinding(binding, context, evaluate) {
  const transform = Array.isArray(binding.transform)
    ? binding.transform.map(step => (step.args === undefined ? step : { ...step, args: resolvedArgs(step.args, context, evaluate) }))
    : binding.transform;
  return evaluate({ ...binding, ...(transform ? { transform } : {}) }, context) ?? null;
}

/** `layout` with every binding evaluated against `context`. `evaluate(binding, input)` is the compiled formula
 *  evaluator's (src/formula-evaluate.mjs in the Worker and its resources). */
export function drawLayout(layout, context, evaluate) {
  if (isBinding(layout)) return evaluateBinding(layout, context, evaluate);
  if (Array.isArray(layout)) return layout.map(item => drawLayout(item, context, evaluate)).filter(item => item !== null && item !== undefined);
  if (!object(layout)) return layout;
  if (layout.$kind === 'each') {
    const items = evaluateBinding(layout.of, context, evaluate);
    if (items === null) return [];
    if (!Array.isArray(items)) throw new TypeError('A layout list must be read from a list.');
    return items.map((item, index) => drawLayout(layout.as, { ...context, item, index }, evaluate)).filter(item => item !== null && item !== undefined);
  }
  if (layout.$kind === 'choose') {
    const chosen = evaluateBinding(layout.when, context, evaluate) === true ? layout.then : layout.else;
    return chosen === undefined ? null : drawLayout(chosen, context, evaluate);
  }
  if (layout.$kind === 'apply') return evaluateBinding({ $kind: 'binding', select: { from: 'self', path: ['value'] }, transform: layout.transform },
    { ...context, value: drawLayout(layout.to, context, evaluate) }, evaluate);
  if (layout.$kind === 'join') return layout.of.flatMap(part => {
    const drawn = drawLayout(part, context, evaluate);
    return drawn === null ? [] : Array.isArray(drawn) ? drawn : [drawn];
  });
  const drawn = {};
  for (const [key, value] of Object.entries(layout)) {
    const placed = drawLayout(value, context, evaluate);
    if (placed !== null && placed !== undefined) drawn[key] = placed;
  }
  return drawn;
}
