// Configuration aspects are independent data. Applying a partial configuration
// changes only the named aspects, including an explicit empty value that clears
// an aspect. It never resets settings the person did not choose to apply.
import aspects from './configuration-aspects.json' with { type: 'json' };
import { normalizeSavedView } from './saved-view-engine.mjs';
import ruleOperators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };

export const configurationAspects = aspects;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const combinators = new Set(ruleOperators.combinators.map(row => row.id));
const operators = new Set(ruleOperators.operators.map(row => row.id));
const checkedRuleFields = (tree, fieldIds) => {
  const known = new Set(fieldIds);
  const visit = node => {
    if (!plainObject(node)) throw new Error('View rules must contain rule groups and comparisons.');
    if (node.kind === 'group') {
      if (!Array.isArray(node.rules) || !combinators.has(node.combinator) || typeof node.negate !== 'boolean')
        throw new Error('View rules need a valid rule group.');
      node.rules.forEach(visit);
    } else if (node.kind === 'rule') {
      if (!known.has(node.field)) throw new Error(`Unknown view field ${String(node.field)}.`);
      if (!operators.has(node.operator) || !plainObject(node.params)) throw new Error('View rules need a valid comparison.');
    } else throw new Error('View rules must contain rule groups and comparisons.');
  };
  visit(tree);
};

export function checkedConfigurationValue(value) {
  let nodes = 0;
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 16) throw new Error('These settings are too large or deeply nested.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plainObject(item) || seen.has(item)) throw new Error('Settings must contain plain values.');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) throw new Error('These settings contain an unsafe field name.');
      visit(child, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 20000) throw new Error('These settings are larger than 20 KB.');
  return structuredClone(value);
}

export function selectedConfigurationAspects(given, format = 'record-view', settings = {}) {
  const known = format === 'record-view' ? aspects.map(row => row.id) : Object.keys(settings);
  const chosen = given === undefined ? known : given;
  if (!Array.isArray(chosen) || !chosen.length || chosen.length > 128
    || chosen.some(id => typeof id !== 'string' || forbidden.has(id) || !known.includes(id)))
    throw new Error('Choose at least one available setting to save.');
  return [...new Set(chosen)];
}

export function captureConfigurationSettings(settings, chosen, fieldIds, format = 'record-view') {
  if (!plainObject(settings)) throw new Error('Configuration settings must be an object.');
  const source = checkedConfigurationValue(settings);
  if (format !== 'record-view' && format !== 'settings') throw new Error('This configuration format is not supported.');
  const selected = selectedConfigurationAspects(chosen, format, source);
  if (format === 'settings') return Object.fromEntries(selected.map(id => [id, source[id]]));
  if (!Array.isArray(fieldIds) || fieldIds.length > 256 || fieldIds.some(id => typeof id !== 'string' || !id || forbidden.has(id)))
    throw new Error('A record configuration needs its available fields.');
  const selectedFields = new Set(aspects.filter(row => selected.includes(row.id)).flatMap(row => row.fields));
  const selectedSource = Object.fromEntries(Object.entries(source).filter(([key]) => selectedFields.has(key)));
  if (selectedSource.rules !== undefined) checkedRuleFields(selectedSource.rules, fieldIds);
  const normalized = normalizeSavedView({ ...selectedSource, label: 'Configuration' }, fieldIds);
  const defaults = { search: '', rules: {kind: 'group', combinator: 'and', negate: false, rules: []},
    sort: [], groups: [], columns: {order: [], hidden: []}, time: null, time_zone: 'UTC', display: null };
  return Object.fromEntries(aspects.filter(row => selected.includes(row.id)).flatMap(row => row.fields.map(key =>
    [key, normalized[key] ?? defaults[key]])));
}

export function applyConfigurationSettings(current, configuration, fieldIds) {
  const format = configuration.format ?? 'record-view';
  const selected = selectedConfigurationAspects(configuration.aspects, format, configuration.settings);
  const saved = captureConfigurationSettings(configuration.settings, selected, fieldIds, format);
  const next = {...checkedConfigurationValue(current), ...saved};
  if (format === 'record-view') {
    // Validate references against the receiving surface's actual fields, never
    // the donor's declaration. Saving a query does not authorize its data.
    normalizeSavedView({...next, label: 'Configuration'}, fieldIds);
    if (next.rules !== undefined) checkedRuleFields(next.rules, fieldIds);
  }
  return next;
}
