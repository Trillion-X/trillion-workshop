// tools/workflows/read-data/check-bindings.mjs
//
// A recipe check rule ({ kind, says, path, ... }): whether it is well formed (checkProblems, every field read from its
// kind row), and the bindings that judge it, filled from its kind row in
// recipe-check-kinds.json (`wrong`, and `holds` when the row has one). The bindings are evaluated by the one shared
// evaluator every engine uses; this module only fills a kind row's DATA with the rule's own fields, and names no kind.
//
// Invariants:
//   - {"$values": <field>, "transform"?} becomes the values at the rule's path(s) in that field: a workflow `values`
//     binding (`take: "all"`), the `this` root read as the checked step's output (`["steps", <subject>, ...]`). A
//     rule with `values` instead of `of` gives those values for `of`.
//   - {"$fill": <field>} becomes the rule's own value of that field.
//   - A kind with `reads` looks each value of `each` up: a `loop` step runs, per value, a one-step definition that
//     `read`s the address `from` builds (the value is the loop's item), with item errors tolerated, so
//     {"$read": true, "transform"?} is the list of what each read answered (a failed read is
//     {"tolerated_error": {"item": <the value>, ...}}). The one-step definition is named by the BLAKE3 of its read,
//     so the same read is one definition wherever it is used.
//   - A kind with no `wrong` binding is refused, by name, never passed.
//   - withCorrections gives every checked step one correction round: a refused answer becomes a task anyone takes,
//     checked by the same rules, and later steps read the answer that held (S#answer).
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// The check vocabulary (kinds, the fields each takes, the bindings that judge it, roots, catalogs) is DATA, not code:
// adding a kind is adding a row.
export const CHECK_VOCABULARY = JSON.parse(readFileSync(new URL('../recipe-check-kinds.json', import.meta.url), 'utf8'));
const KINDS = CHECK_VOCABULARY;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Whether a value has a shape a check field can take. The shapes are the closed set of JSON value forms.
const SHAPES = {
  list: value => Array.isArray(value),
  words: value => Array.isArray(value) && value.length > 0 && value.every(nonempty),
  count: value => Number.isInteger(value) && value > 0,
  key: value => nonempty(value),
  catalog: (value, vocabulary) => vocabulary.catalogs.some(row => row.catalog === value),
};

// The JSON Schema a path's keys walk down, or undefined once the schema stops saying (no properties, no items): a
// list key `*` goes to `items`, any other key to `properties`. Only a schema that lists its properties can refuse a key.
function schemaAt(schema, keys) {
  let at = schema;
  for (const key of keys) {
    if (!object(at)) return { known: false };
    if (key === '*') { if (!object(at.items)) return { known: false }; at = at.items; continue; }
    if (!object(at.properties) || at.additionalProperties !== undefined && at.additionalProperties !== false) return { known: false };
    if (!(key in at.properties)) return { known: true, missing: key };
    at = at.properties[key];
  }
  return { known: true };
}

// Every problem with the keys of a path-shaped field: a list of keys (or a list of such lists) from a root, reading only
// earlier steps, and naming only fields the schema it reads declares (the step's or an earlier step's submit, or the
// input schema), so a check can never read a field nothing hands back.
function pathProblems(value, where, field, stepId, earlier, vocabulary, schemas) {
  const roots = vocabulary.roots.map(row => row.root);
  const problems = [];
  const paths = Array.isArray(value) && Array.isArray(value[0]) ? value : [value];
  for (const path of paths) {
    if (!Array.isArray(path) || !roots.includes(path[0]) || path.some(key => typeof key !== 'string')) { problems.push(`${where}.${field} must be a list of keys starting with ${roots.map(root => `"${root}"`).join(', ')}.`); continue; }
    if (path[0] === 'steps' && (path[1] === stepId || !earlier.has(path[1]))) { problems.push(`${where}.${field} reads step "${path[1]}", which is not an earlier step.`); continue; }
    const [schema, keys] = path[0] === 'this' ? [schemas?.this, path.slice(1)] : path[0] === 'input' ? [schemas?.input, path.slice(1)] : [schemas?.steps?.get(path[1]), path.slice(2)];
    const found = schemaAt(schema, keys);
    if (found.missing) problems.push(`${where}.${field} reads "${found.missing}", which ${path[0] === 'steps' ? `step "${path[1]}"` : path[0] === 'this' ? 'this step' : 'the input'} does not declare.`);
  }
  return problems;
}

// Every problem with one list of check rules (the engine's `check` step config), for step `stepId` whose earlier
// steps are `earlier`. What a kind takes comes from its row in the vocabulary; there is no branch on a kind's name.
export function checkProblems(checks, name, stepId, earlier, vocabulary = CHECK_VOCABULARY, schemas = null) {
  const problems = [];
  const kinds = new Map(vocabulary.kinds.map(row => [row.kind, row]));
  for (const [at, check] of (checks ?? []).entries()) {
    const where = `${name}.checks[${at}]`;
    const row = object(check) ? kinds.get(check.kind) : undefined;
    if (!row) { problems.push(`${where}.kind must be one of: ${[...kinds.keys()].join(', ')}.`); continue; }
    if (!nonempty(check.says)) problems.push(`${where}.says must say, in plain words, what the check asks for.`);
    const refused = (field, refusal) => `${where}.${field} ${(refusal ?? 'is not the right shape.').replace('{catalogs}', vocabulary.catalogs.map(entry => entry.catalog).join(', '))}`;
    for (const { field, shape, required, refusal } of row.fields) {
      const value = check[field];
      if (value === undefined) { if (required) problems.push(refused(field, refusal)); continue; }
      if (shape === 'path') problems.push(...pathProblems(value, where, field, stepId, earlier, vocabulary, schemas));
      else if (!SHAPES[shape](value, vocabulary)) problems.push(refused(field, refusal));
    }
    for (const { fields, refusal } of row.one_of ?? []) if (fields.every(field => !(field in check))) problems.push(`${where} ${refusal}`);
  }
  return problems;
}


const byKind = new Map(KINDS.kinds.map(row => [row.kind, row]));

const isPath = value => Array.isArray(value) && value.every(key => typeof key === 'string');
const rooted = (path, subject) => (path[0] === 'this' ? ['steps', subject, ...path.slice(1)] : path);

/** The paths a rule field holds: one path, or a list of paths read together. */
function pathsOf(field, subject) {
  if (isPath(field)) return rooted(field, subject);
  return field.map(path => rooted(path, subject));
}

function filled(template, rule, subject, read = null) {
  if (Array.isArray(template)) return template.map(item => filled(item, rule, subject, read));
  if (!template || typeof template !== 'object') return template;
  if ('$fill' in template) return rule[template.$fill];
  if ('$read' in template) {
    const transform = template.transform ? filled(template.transform, rule, subject, read) : undefined;
    return { $kind: 'binding', select: { from: 'steps', key: read, path: 'output' }, ...(transform ? { transform } : {}) };
  }
  if ('$values' in template) {
    const transform = template.transform ? filled(template.transform, rule, subject, read) : undefined;
    const field = rule[template.$values];
    if (field === undefined && template.$values === 'of' && Array.isArray(rule.values)) {
      return { $kind: 'binding', select: { from: 'literal', value: rule.values }, ...(transform ? { transform } : {}) };
    }
    return { $kind: 'binding', values: pathsOf(field ?? [], subject), take: 'all', ...(transform ? { transform } : {}) };
  }
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, filled(value, rule, subject, read)]));
}

/** { holds, wrong, reads } for rule number `index` of the step `subject`: `holds` is null when the kind judges by
 *  `wrong` alone; `reads` (when the kind looks things up) is the loop step and the one-step definition it runs. */
export function checkBindings(rule, subject, index = 0) {
  const row = byKind.get(rule.kind);
  if (!row?.wrong) throw new Error(`A ${rule.kind} check has no binding in recipe-check-kinds.json, so it cannot be judged.`);
  let reads = null;
  if (row.reads) {
    const loop = `${subject}#read-${index}`;
    const from = filled(row.reads.from, rule, subject);
    const definition = {
      id: `check-read:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(from)))).slice(0, 32)}`,
      name: 'Read one value', kind: 'workflow', is_active: true, version: 1,
      steps: [{ id: 'read', kind: 'read', config: { from } }], edges: [],
    };
    reads = { definition, step: { id: loop, kind: 'loop', config: { source: filled(row.reads.each, rule, subject), item_var: 'item', definition_id: definition.id, tolerate_item_errors: true } } };
    return { holds: row.holds ? filled(row.holds, rule, subject, loop) : null, wrong: filled(row.wrong, rule, subject, loop), reads };
  }
  return { holds: row.holds ? filled(row.holds, rule, subject) : null, wrong: filled(row.wrong, rule, subject), reads };
}

/** The values that break a rule, each as the words a refusal shows: as it is when the kind says them in words
 *  (`wrong_is_text`), else as JSON. */
const shown = (rule, wrong) => (byKind.get(rule.kind)?.wrong_is_text ? wrong : {
  ...wrong,
  transform: [...(wrong.transform ?? []), op('map_to_nodes', { item_var: '$value', template: binding({ from: 'vars', key: '$value' }, [op('stringify', { format: 'json' })]) })],
});

const binding = (select, transform) => ({ $kind: 'binding', select, ...(transform ? { transform } : {}) });
const item = (path, transform) => binding({ from: 'vars', key: '$item', ...(path ? { path } : {}) }, transform);
const op = (name, args) => ({ op: `op:core.${name}`, ...(args ? { args } : {}) });


/**
 * A step's checks as ordinary engine steps, so the engine needs no check kind: `<subject>#checks` is a `return` step
 * whose output `held` says, rule by rule, whether it holds; only when one does not, `<subject>#wrong` (a `return`
 * step) lists the values that break each rule and `<subject>#refused` (a `fail` step) names each rule that does not
 * hold with up to eight of them. `onwards(to)` is the edge the next step
 * is reached by: only when every rule holds. `uses` are the one-step definitions its lookups run, which go to the engine
 * with the definition.
 */
export function checkSteps(subject, rules) {
  const judged = rules.map((rule, index) => ({ rule, ...checkBindings(rule, subject, index) }));
  const reads = judged.map(({ reads: lookups }) => lookups).filter(Boolean);
  const held = judged.map(({ holds, wrong }) => holds ?? { ...wrong, transform: [...(wrong.transform ?? []), op('array_length'), op('eq', { value: 0 })] });
  const checks = `${subject}#checks`;
  const wrong = `${subject}#wrong`;
  const refused = `${subject}#refused`;
  const said = binding({ from: 'steps', key: wrong, path: 'output.problems' }, [
    op('filter_where', { predicate: [op('get_path', { path: 'held' }), op('not')] }),
    op('map_to_nodes', { template: item(null, [op('concat', { values: [
      item('says'), ' (', item('wrong', [op('join', { delimiter: '; ' })]), ')',
    ] })]) }),
    op('join', { delimiter: '; ' }),
  ]);
  const problems = judged.map(({ rule, wrong: values }, index) => ({
    says: rule.says ?? rule.kind,
    held: binding({ from: 'steps', key: checks, path: `output.held.${index}` }),
    wrong: shown(rule, values),
  }));
  return {
    steps: [
      ...reads.map(({ step }) => step),
      { id: checks, kind: 'return', config: { value: { held } } },
      { id: wrong, kind: 'return', config: { value: { problems } } },
      { id: refused, kind: 'fail', config: { error: said } },
    ],
    edges: [
      ...(reads.length
        ? reads.flatMap(({ step }) => [{ from: subject, to: step.id, kind: 'always' }, { from: step.id, to: checks, kind: 'always' }])
        : [{ from: subject, to: checks, kind: 'always' }]),
      { from: checks, to: wrong, kind: 'on_result', config: binding({ from: 'input', path: 'output.held' }, [op('array_contains', { value: false })]) },
      { from: wrong, to: refused, kind: 'always' },
    ],
    uses: reads.map(({ definition }) => definition),
    onwards: to => ({ from: checks, to, kind: 'on_result', config: binding({ from: 'input', path: 'output.held' }, [op('array_contains', { value: false }), op('not')]) }),
  };
}


// Every reference to step `from` in a value (a binding's select key or its `steps` path, or a values path
// ["steps", from, ...]) made a reference to step `to`.
function repointStep(value, from, to) {
  if (Array.isArray(value)) {
    if (value[0] === 'steps' && value[1] === from) return ['steps', to, ...value.slice(2)];
    return value.map(item => repointStep(item, from, to));
  }
  if (!object(value)) return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, repointStep(inner, from, to)]));
  if (object(out.select) && out.select.from === 'steps') {
    if (out.select.key === from) out.select = { ...out.select, key: to };
    else if (out.select.key === undefined && typeof out.select.path === 'string' && (out.select.path === from || out.select.path.startsWith(`${from}.`))) {
      out.select = { ...out.select, path: to + out.select.path.slice(from.length) };
    }
  }
  return out;
}

/**
 * One correction round for every checked step of a definition (a step S with S#checks, S#wrong and S#refused, as
 * checkSteps makes them): a refused answer becomes a task, never a failed run on the first try.
 *   - S#refused gets an on_failure edge to S#again, an ask anyone takes ("anyone"), handed S's words (do, submit, the
 *     checks' says) and `refused`: what S#wrong found, each rule's words with only the values breaking it. The refused
 *     answer itself is not copied: a run's answers already ride with its task, and a copy doubles a large answer.
 *   - S#again is checked by the same rules (S#again#checks, #wrong, #refused); its #refused fails the run in the rules' own words.
 *   - S#answer, a return step, is S#again's answer when it ran, else S's; what left S#checks when the checks held now
 *     leaves S#answer, and every later reader of S reads S#answer (S's own check steps keep reading S).
 * A step that already has S#again is left as it is, so this runs again over a stored definition without change.
 * Answers { definition, subjects }: the new definition and the step ids that got a round.
 */
export function withCorrections(definition) {
  const out = structuredClone(definition);
  const ids = new Set(out.steps.map(step => step.id));
  const subjects = out.steps
    .filter(step => !step.id.includes('#') && ids.has(`${step.id}#checks`) && ids.has(`${step.id}#wrong`) && ids.has(`${step.id}#refused`) && !ids.has(`${step.id}#again`))
    .map(step => step.id);
  const done = [];
  for (const subject of subjects) {
    const step = out.steps.find(candidate => candidate.id === subject);
    const context = object(step.config?.context) ? step.config.context : {};
    const rules = (context.checks ?? []).filter(rule => object(rule) && rule.kind);
    if (!rules.length) continue;
    const answer = `${subject}#answer`;
    const again = `${subject}#again`;
    const own = id => id === subject || id.startsWith(`${subject}#`);
    out.steps = out.steps.map(other => (own(other.id) ? other : repointStep(other, subject, answer)));
    out.edges = out.edges.map(edge => (own(edge.from) && own(edge.to) ? edge : edge.config ? { ...edge, config: repointStep(edge.config, subject, answer) } : edge));
    const ask = { id: again, kind: 'ask', config: { name: 'anyone',
      input: { do: context.do, submit: context.submit, checks: rules.map(rule => rule.says ?? rule.kind), refused: binding({ from: 'steps', key: `${subject}#wrong`, path: 'output.problems' }) },
      context: { ...context, step_id: again, title: `${context.title ?? subject}: correct the answer the checks refused`, corrects: subject } } };
    const judged = checkSteps(again, rules.map(rule => repointStep(rule, subject, again)));
    const coalesced = { $kind: 'binding', select: { from: 'literal', value: 0 }, resolve_nested_bindings: true,
      transform: [op('coalesce', { values: [binding({ from: 'steps', key: again, path: 'output' }), binding({ from: 'steps', key: subject, path: 'output' })] })] };
    const at = out.steps.findIndex(candidate => candidate.id === `${subject}#refused`);
    out.steps.splice(at + 1, 0, ask, ...judged.steps, { id: answer, kind: 'return', config: { value: coalesced } });
    const onwards = out.edges.filter(edge => edge.from === `${subject}#checks` && edge.to !== `${subject}#wrong`);
    out.edges = out.edges.filter(edge => !onwards.includes(edge));
    out.edges.push(onwards.length ? { ...onwards[0], to: answer } : { from: `${subject}#checks`, to: answer, kind: 'on_result', config: judged.onwards(answer).config });
    out.edges.push(...[...new Set(onwards.map(edge => edge.to))].map(to => ({ from: answer, to, kind: 'always' })));
    out.edges.push({ from: `${subject}#refused`, to: again, kind: 'on_failure' }, ...judged.edges, judged.onwards(answer));
    if (judged.uses.length) out.uses = [...(out.uses ?? []), ...judged.uses.filter(used => !(out.uses ?? []).some(known => known.id === used.id))];
    done.push(subject);
  }
  return { definition: out, subjects: done };
}

/** The answers a run's checks refused: subject step id → each rule that did not hold, said with the values breaking it.
 *  `ran` is the run's steps by id, as the engine gives them back. */
export function refusalsOf(definition, ran) {
  const refusals = new Map();
  for (const step of definition.steps ?? []) {
    if (step.kind !== 'fail' || !step.id.endsWith('#refused') || ran[step.id]?.status !== 'failed') continue;
    const subject = step.id.slice(0, -'#refused'.length);
    const problems = (ran[`${subject}#wrong`]?.output?.problems ?? []).filter(problem => problem.held === false);
    refusals.set(subject, problems.length ? problems.map(problem => `${problem.says} (${(problem.wrong ?? []).join('; ')})`) : [ran[step.id].error]);
  }
  return refusals;
}
