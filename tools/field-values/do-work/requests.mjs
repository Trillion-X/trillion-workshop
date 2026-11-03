// tools/field-values/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a
// sentence that says what to send, and returns the answer. The rows, fields, rules, sources and precedence all arrive in
// the request (the precedence defaults to read-data/value-sources.json); no field, source or kind is named in code.
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { planAColumnFill } from './plan-a-column-fill.mjs';
import { precedenceOf } from './precedence.mjs';
import { isPath, readAt } from './row-paths.mjs';
import { setFieldsByRules } from './set-fields-by-rules.mjs';
import { settleFieldValues } from './settle-field-values.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };
const isId = value => (typeof value === 'string' && value.length > 0) || Number.isInteger(value);
const isTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function needFields(fields, what = 'fields') {
  need(Array.isArray(fields) && fields.every(field => isObject(field) && typeof field.id === 'string' && typeof field.kind === 'string' && (field.path === undefined || isPath(field.path))),
    `${what} must be a list of { id, kind, path? }: kind picks the comparisons (tools/formulas list-comparisons), path is keys and positions into a row (the id by default).`);
  need(new Set(fields.map(field => field.id)).size === fields.length, `two of the ${what} share an id; each field id must be its own.`);
}

function needSource(source, what) {
  need(isObject(source) && typeof source.kind === 'string' && source.kind.length > 0, `${what} needs a source { kind, by?, at?, confidence? }: kind is who offered it (person, rule, source, ai or a kind of your precedence).`);
  need(source.at === undefined || isTime(source.at), `${what}: source.at must be a date and time like 2026-07-05T10:00:00Z.`);
  need(source.confidence === undefined || typeof source.confidence === 'string' || (typeof source.confidence === 'number' && source.confidence >= 0 && source.confidence <= 1),
    `${what}: source.confidence is a number between 0 and 1 or one of the precedence's confidence words.`);
}

/** Which value each field keeps from every offer made for it, with who offered each and why the others lost. */
export function settleValues(request) {
  need(isObject(request), 'Send an object with offers: [{ row, field, value, source: { kind, by?, at?, confidence? } }].');
  need(Array.isArray(request.offers), 'offers must be a list of { row, field, value, source }, one per value offered for a field of a row.');
  request.offers.forEach((offer, at) => {
    need(isObject(offer) && isId(offer.row) && typeof offer.field === 'string' && offer.field.length > 0, `offer ${at} needs a row (its id) and a field (its id).`);
    need(offer.withdraws === true || Object.hasOwn(offer, 'value'), `offer ${at} needs a value, or withdraws: true to take back what its source offered earlier.`);
    needSource(offer.source, `offer ${at}`);
  });
  need(request.as_of === undefined || isTime(request.as_of), 'as_of must be a date and time like 2026-07-05T10:00:00Z.');
  return settleFieldValues(request);
}

/** The changes a person's ordered rule groups make to their rows, previewed per rule, never over a stronger source. */
export function setFields(request) {
  need(isObject(request), 'Send an object with records, fields and groups of rules.');
  need(Array.isArray(request.records) && request.records.every(isObject), 'records must be a list of objects (the rows).');
  needFields(request.fields);
  const fieldIds = new Set(request.fields.map(field => field.id));
  need(Array.isArray(request.groups) && request.groups.length > 0, 'groups must be a list of { id, rules: [{ id, says?, when?, set: [{ field, value } or { field, from }] }] }, in the order they are tried.');
  const ruleIds = new Set();
  for (const group of request.groups) {
    need(isObject(group) && typeof group.id === 'string' && Array.isArray(group.rules), 'every group needs an id and a list of rules.');
    for (const rule of group.rules) {
      need(isObject(rule) && typeof rule.id === 'string' && rule.id.length > 0, `every rule in group ${group.id} needs an id.`);
      need(!ruleIds.has(rule.id), `two rules share the id ${rule.id}; each rule id must be its own.`);
      ruleIds.add(rule.id);
      need(rule.when === undefined || rule.when === null || isObject(rule.when), `rule ${rule.id}: when is a tools/formulas rule tree { kind: "group", combinator, negate, rules } or { kind: "rule", field, operator, params }; leave it out to match every row.`);
      need(Array.isArray(rule.set) && rule.set.length > 0, `rule ${rule.id}: set must list the fields it sets, each { field, value } or { field, from: [path in the row] }.`);
      for (const set of rule.set) {
        need(isObject(set) && fieldIds.has(set.field), `rule ${rule.id} sets ${set?.field}, which is not one of the fields; add it to fields with its path.`);
        need(Object.hasOwn(set, 'value') !== Object.hasOwn(set, 'from') && (!Object.hasOwn(set, 'from') || isPath(set.from)), `rule ${rule.id}: each set item has a value or a from path, not both.`);
      }
    }
  }
  const provenance = request.provenance ?? null;
  need(provenance === null || (isObject(provenance) && isPath(provenance.path) && typeof provenance.kind_key === 'string' && typeof provenance.by_key === 'string'),
    'provenance must be { path: [where each row keeps who wrote its fields], kind_key, by_key }, e.g. { "path": ["_stamps"], "kind_key": "class", "by_key": "by" }.');
  need(request.id_path === undefined || isPath(request.id_path), 'id_path must be keys and positions to each row\'s id.');
  const policy = precedenceOf(request);
  const ruleKind = request.rule_kind ?? 'rule';
  need(policy.kinds.includes(ruleKind), `rule_kind ${ruleKind} is not a kind of the precedence (${policy.kinds.join(', ')}).`);
  return setFieldsByRules({ ...request, rule_kind: ruleKind });
}

/** The next source calls that fill a column row by row, the values already found, and the rows done without one. */
export function planColumnFill(request) {
  need(isObject(request), 'Send an object with records, id_path, field and sources.');
  need(Array.isArray(request.records) && request.records.every(isObject), 'records must be a list of objects (the rows).');
  need(isPath(request.id_path) && request.id_path.length > 0, 'id_path must be keys and positions to each row\'s id; attempts name rows by it.');
  const rowIds = request.records.map(record => readAt(record, request.id_path));
  need(rowIds.every(isId) && new Set(rowIds).size === rowIds.length, 'every row needs its own id (text or a whole number) at id_path; attempts and calls name rows by it.');
  need(isObject(request.field) && typeof request.field.id === 'string' && (request.field.path === undefined || isPath(request.field.path)), 'field must be { id, path? }: the column to fill.');
  need(Array.isArray(request.sources) && request.sources.length > 0, 'sources must be a list of { id, tool, input: { name: { from: [path] } or { value } }, answer_path?, kind?, cost? }, in the order to ask them.');
  const sourceIds = new Set();
  for (const source of request.sources) {
    need(isObject(source) && typeof source.id === 'string' && typeof source.tool === 'string' && source.tool.length > 0, 'every source needs an id and the tool to run.');
    need(!sourceIds.has(source.id), `two sources share the id ${source.id}.`);
    sourceIds.add(source.id);
    need(source.input === undefined || (isObject(source.input) && Object.values(source.input).every(from => isObject(from) && (Object.hasOwn(from, 'value') || isPath(from.from)))),
      `source ${source.id}: input maps each input name to { from: [path in the row] } or { value }.`);
    need(source.answer_path === undefined || isPath(source.answer_path), `source ${source.id}: answer_path is keys and positions into the tool's answer.`);
    need(source.cost === undefined || (typeof source.cost === 'number' && source.cost >= 0), `source ${source.id}: cost is a number of at least 0.`);
  }
  if (request.run_if !== undefined) {
    needFields(request.fields, 'fields (for run_if)');
    need(isObject(request.run_if), 'run_if is a tools/formulas rule tree over the fields.');
    const checked = filterRecords({ records: [], fields: request.fields, tree: request.run_if, operators: request.operators });
    need(checked.incomplete.length === 0, `run_if is not finished: ${JSON.stringify(checked.incomplete)}; fix it so no row is skipped by a rule that cannot be read.`);
  }
  if (request.accept !== undefined) {
    need(isObject(request.accept) && typeof request.accept.kind === 'string' && isObject(request.accept.tree), 'accept must be { kind, tree }: a tools/formulas rule tree over the field "value", the answer, of that kind.');
    const checked = filterRecords({ records: [], fields: [{ id: 'value', kind: request.accept.kind, path: ['value'] }], tree: request.accept.tree, operators: request.operators });
    need(checked.incomplete.length === 0, `accept is not finished: ${JSON.stringify(checked.incomplete)}.`);
  }
  need(request.attempts === undefined || (Array.isArray(request.attempts) && request.attempts.every(attempt => isObject(attempt) && isId(attempt.row) && sourceIds.has(attempt.source))),
    'attempts must be a list of { row, source, answer? , error?, cost? }, one per call already made, naming a row id and one of the sources.');
  need(request.stop_after_same_failure === undefined || (Number.isInteger(request.stop_after_same_failure) && request.stop_after_same_failure >= 1), 'stop_after_same_failure is a whole number of at least 1.');
  need(request.most_calls === undefined || (Number.isInteger(request.most_calls) && request.most_calls >= 1), 'most_calls is a whole number of at least 1.');
  return planAColumnFill(request);
}
