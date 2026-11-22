// tools/workflows/read-data/choose-the-workflows-that-fire.mjs
//
// Every workflow is a candidate branch of the one tree. Each says when it fires on its own row (branches/fires-when.json):
// a list of conditions, each the {fields, tree} tool:filter-rows-by-rules takes, evaluated over one seed part. This takes
// the person's own workflow rows as values (`own`, read by the caller from wherever the person keeps them) beside
// every recipe this Workshop installs (recipes/), the person's own row winning, and lets the formula engine (its Rust module, called directly) say which
// conditions keep which parts. Nothing here names a workflow, a branch or a tag: a workflow added, or a kit installed,
// is a candidate at once.
//
//   chooseTheWorkflowsThatFire({ parts, own?: [{ id, value: { recipe?, title, fires_when, definition?, kept_in? } }], operators?, within?, installed?, over_installed? })
//     -> { workflows, own, catalog_only, chosen: [{ workflow, label, part, condition, made_by, from, input, installed, definition?, kept_in? }],
//          unfinished: [{ workflow, condition, incomplete }], unconditioned: [{ workflow, label }], unmatched_parts,
//          within: [{ workflow, part, condition }] }
//
// within names the workflows of the runs this choice is made inside (the run itself and every run above it). A workflow
// in that chain is never chosen again, so no workflow starts itself through its own parts, at any depth; its matches are
// named in within instead of being dropped unseen.
//
// installed: false leaves the installed recipes out, and with them every own row whose id an installed recipe holds: the
// candidates are only the person's rows that exist nowhere else (while another caller still chooses the installed ones),
// and the ids over_installed lists, whose own rows are candidates even though an installed recipe holds them too.
// A chosen own row that carries its definition hands it on, so whoever starts the run starts it from the row.
//
// installed says an installed recipe holds the chosen id, so the installed workflow's own wakes can start it. kept_in is
// where an own row says its definition is kept (the caller's name for that store, given when the caller read only the
// row's conditions): a choice made by that row's own conditions names it when no installed recipe holds the id, or
// over_installed lists it, so the caller starts that one from the row it reads there.
//
// A condition that is Off, unfinished (a rule the engine cannot evaluate) or has no rule at all chooses nothing; the
// last two are named so the run can fix them, and so is a part that lacks a field the condition reads (unfinished, with the
// field named), so no condition is dropped unseen. A workflow with no condition is named in unconditioned, so the run can
// judge it by its words and write the condition it judged back onto the workflow's row.

import { readFileSync } from 'node:fs';
import { initSync, filterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import { conditionProblems, FIRES_WHEN } from './fires-when.mjs';
import { publicRecipes } from './public-recipes.mjs';
initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parsed = (value, where) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error(`${where} is not JSON.`); }
};

// The installed catalog: every recipe of the files beside this module, by id.
function catalogRecipes() {
  const byId = new Map();
  for (const payload of publicRecipes()) {
    if (payload.id && !byId.has(payload.id)) byId.set(payload.id, { label: payload.label, conditions: payload[FIRES_WHEN.field] });
  }
  return byId;
}

// The person's own workflow rows, as given, by recipe id.
function ownWorkflows(rows = []) {
  if (!Array.isArray(rows) || !rows.every(row => object(row) && typeof row.id === 'string')) throw new Error('own must be a list of the person\'s workflow rows, each { id, value }.');
  const byId = new Map();
  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const value = row.value ?? {};
    const id = typeof value.recipe === 'string' && value.recipe ? value.recipe : `workflow:${row.id}`;
    if (value.kept_in !== undefined && (typeof value.kept_in !== 'string' || !value.kept_in)) throw new Error(`${row.id} kept_in must name where the row is kept.`);
    byId.set(id, { label: value.title, conditions: parsed(value[FIRES_WHEN.field], `${row.id} ${FIRES_WHEN.field}`), definition: parsed(value.definition, `${row.id} definition`), keptIn: value.kept_in });
  }
  return byId;
}

// The rules a condition holds, each as the key its rarity is counted under: a rule with a list of values gives one key
// per value (a tag), any other rule one key for itself; a field is named by its path, so two conditions that read the
// same place share keys.
function ruleLeaves(condition) {
  const pathOf = new Map(condition.fields.map(field => [field.id, JSON.stringify(field.path ?? [field.id])]));
  const leaves = [];
  const walk = node => {
    if (node?.kind === 'group') { if (!node.negate) node.rules.forEach(walk); return; }
    if (node?.kind !== 'rule') return;
    const at = pathOf.get(node.field);
    const values = Array.isArray(node.params?.values) ? node.params.values : null;
    leaves.push({ rule: node, keys: values ? values.map(value => `${at}|${node.operator}|${JSON.stringify(value)}`) : [`${at}|${node.operator}|${JSON.stringify(node.params ?? null)}`], values });
  };
  walk(condition.tree);
  return leaves;
}

const valueAt = (record, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), record);

// The fields a condition's rules read that a part does not carry at all: such a rule cannot be evaluated for that part.
function fieldsMissingFrom(condition, part) {
  const missing = new Set();
  const walk = node => {
    if (node?.kind === 'group') return node.rules.forEach(walk);
    if (node?.kind !== 'rule') return;
    const field = condition.fields.find(item => item.id === node.field);
    if (field && valueAt(part, field.path ?? [field.id]) === undefined) missing.add(field.id);
  };
  walk(condition.tree);
  return [...missing];
}

// The keys of one condition that this part meets: a value rule by the values the part holds, any other rule when the
// formulas engine says it holds for the part alone.
function metKeys(condition, part, operators) {
  const met = [];
  for (const { rule, keys, values } of ruleLeaves(condition)) {
    if (!filterRecords({ records: [part], fields: condition.fields, tree: rule, ...(operators ? { operators } : {}) }).matches.length) continue;
    if (!values) { met.push(...keys); continue; }
    const field = condition.fields.find(item => item.id === rule.field);
    const held = [valueAt(part, field.path ?? [field.id])].flat();
    values.forEach((value, at) => { if (held.includes(value)) met.push(keys[at]); });
  }
  return met;
}

export async function chooseTheWorkflowsThatFire(input = {}) {
  const { parts, own: ownRows = [], operators, within = [], installed = true, over_installed: overInstalled = [] } = input;
  if (typeof installed !== 'boolean') throw new Error('installed must be true or false.');
  if (!Array.isArray(overInstalled) || !overInstalled.every(id => typeof id === 'string')) throw new Error('over_installed must be a list of workflow ids.');
  if (!Array.isArray(within) || !within.every(id => typeof id === 'string')) throw new Error('within must be a list of workflow ids.');
  if (!Array.isArray(parts) || !parts.length || !parts.every(object)) throw new Error('parts must be a list of the seed\'s parts, each an object of its typed fields.');
  const shipped = catalogRecipes();
  const catalog = installed ? shipped : new Map();
  const own = ownWorkflows(ownRows);
  if (!installed) for (const id of [...own.keys()]) if (shipped.has(id) && !overInstalled.includes(id)) own.delete(id);
  const ids = [...new Set([...own.keys(), ...catalog.keys()])].sort();
  const matches = [], unfinished = [], unconditioned = [];
  // How many workflows hold each rule key, over every live condition: the rarer a key, the more a match on it says.
  const holders = new Map();
  let conditioned = 0;
  for (const workflow of ids) {
    const mine = own.get(workflow), shipped = catalog.get(workflow);
    const label = mine?.label ?? shipped?.label;
    const [conditions, from] = mine?.conditions !== undefined ? [mine.conditions, 'own'] : [shipped?.conditions, mine ? 'catalog-condition' : 'catalog'];
    const live = (Array.isArray(conditions) ? conditions : []).filter(item => !FIRES_WHEN.off_states.includes(item?.state));
    if (!live.length) { unconditioned.push({ workflow, label }); continue; }
    const keys = new Set();
    for (const item of live) {
      const wrong = conditionProblems([item], `${workflow} ${FIRES_WHEN.field}`);
      if (wrong.length) { unfinished.push({ workflow, condition: item?.label ?? null, incomplete: wrong }); continue; }
      ruleLeaves(item.condition).forEach(leaf => leaf.keys.forEach(key => keys.add(key)));
      const answer = filterRecords({ records: parts, fields: item.condition.fields, tree: item.condition.tree, ...(operators ? { operators } : {}) });
      for (const part of answer.matches) matches.push({ workflow, label, part, item, from });
      // A part the condition kept nothing from, that lacks a field the condition reads, is named as unfinished, never dropped unseen.
      const kept = new Set(answer.matches);
      parts.forEach((part, at) => {
        if (kept.has(at)) return;
        const missing = fieldsMissingFrom(item.condition, part);
        if (missing.length) unfinished.push({ workflow, condition: item?.label ?? null, part: at, incomplete: missing.map(field => `part ${at} does not carry ${field}`) });
      });
    }
    if (keys.size) conditioned += 1;
    keys.forEach(key => holders.set(key, (holders.get(key) ?? 0) + 1));
  }
  // Specificity: the sum over the rule keys a part met of log(conditioned workflows / workflows holding that key), times the
  // condition's weight (its measured share of runs that ended done, written by learn-and-prune; 1 before any run).
  const chain = new Set(within);
  const inside = matches.filter(({ workflow }) => chain.has(workflow)).map(({ workflow, part, item }) => ({ workflow, part, condition: item.label }));
  const chosen = matches.filter(({ workflow }) => !chain.has(workflow)).map(({ workflow, label, part, item, from }) => {
    const matched = metKeys(item.condition, parts[part], operators);
    const weight = typeof item.weight === 'number' ? item.weight : 1;
    const score = weight * matched.reduce((sum, key) => sum + Math.log(conditioned / (holders.get(key) ?? conditioned)), 0);
    const definition = from === 'own' ? own.get(workflow)?.definition : undefined;
    const keptIn = from === 'own' && (!shipped.has(workflow) || overInstalled.includes(workflow)) ? own.get(workflow)?.keptIn : undefined;
    return { workflow, label, part, condition: item.label, made_by: item.made_by, from, matched, weight, score: Number(score.toFixed(6)), input: item.input ?? {}, installed: shipped.has(workflow), ...(definition ? { definition } : {}), ...(keptIn ? { kept_in: keptIn } : {}) };
  }).sort((a, b) => a.part - b.part || b.score - a.score || (a.workflow < b.workflow ? -1 : 1));
  // A condition that keeps more than half of the parts it is shown says nothing about which work a part is: it is named in
  // broad so learn-and-prune rewrites it around the one situation its workflow is for.
  const kept = new Map();
  for (const { workflow, item, part } of matches) {
    const key = `${workflow}\u0000${item.label}`;
    if (!kept.has(key)) kept.set(key, { workflow, condition: item.label, parts: new Set() });
    kept.get(key).parts.add(part);
  }
  const broad = parts.length < 2 ? [] : [...kept.values()].filter(entry => entry.parts.size * 2 > parts.length)
    .map(entry => ({ workflow: entry.workflow, condition: entry.condition, kept_parts: entry.parts.size, of: parts.length }));
  const rankOf = new Map();
  for (const item of chosen) { item.rank = (rankOf.get(item.part) ?? 0) + 1; rankOf.set(item.part, item.rank); }
  return {
    workflows: ids.length,
    own: own.size,
    catalog_only: ids.filter(id => !own.has(id)).length,
    chosen,
    unfinished,
    broad,
    unconditioned,
    unmatched_parts: parts.map((_, at) => at).filter(at => !rankOf.has(at)),
    within: inside,
  };
}
