// tools/field-values/do-work/set-fields-by-rules.mjs
//
// Purpose: rules that set fields on the rows they match, the way a bookkeeping or spend table codes its transactions.
// A rule is a rule tree (tools/formulas' own, matched by its filterRecords) and the fields it sets; rules sit in groups,
// and groups and rules are read in order, so the first rule that matches a row and sets a field decides that field
// (rules that set different fields all apply). Before anything is written the answer previews, per rule, the rows it
// matches and what it would change, so a person can see a new rule's reach over the rows that already exist.
//
// Non-Negotiable Invariants:
//   1. A rule never writes over a value a stronger source holds (precedence.mjs): a person's value stays, and a value
//      whose source is not known holds or yields as the precedence says. Such a field is answered as `held`, naming who
//      holds it.
//   2. A rule that is not finished (its tree names an unknown field or comparison, or misses values) sets nothing and
//      is answered in `incomplete`; it is never guessed at.
//   3. A field a rule set earlier (its provenance names this kind and a rule) that no rule sets now goes back to empty,
//      so taking a rule away undoes what it alone did; a field a rule set is never left claiming a rule that is gone.
//   4. Nothing is written: the answer holds the changes, the rows as they would be, and the provenance to keep beside
//      each value, for the list's owner to write.
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { precedenceOf } from './precedence.mjs';
import { isEmpty, readAt, sameValue, writeAt } from './row-paths.mjs';

/** The changes a person's ordered rule groups make to their rows, previewed per rule. */
export function setFieldsByRules(request) {
  const { records, fields, groups, operators } = request;
  const policy = precedenceOf(request);
  const ruleKind = request.rule_kind;
  const fieldById = new Map(fields.map(field => [field.id, field]));
  const pathOf = id => fieldById.get(id).path ?? [id];
  const provenance = request.provenance ?? null;
  const holderOf = (record, id) => {
    if (!provenance) return null;
    const held = readAt(record, [...provenance.path, id]);
    return held && typeof held === 'object' ? { kind: held[provenance.kind_key] ?? null, by: held[provenance.by_key] ?? null } : null;
  };
  const idOf = (record, at) => (request.id_path ? readAt(record, request.id_path) ?? at : at);

  const rules = groups.flatMap(group => group.rules.map(rule => ({ group: group.id, rule })));
  const summaries = rules.map(({ group, rule }) => {
    const tree = rule.when ?? null;
    const found = filterRecords({ records, fields, tree, operators });
    const unfinished = tree !== null && (found.incomplete.length > 0);
    return { group, rule: rule.id, says: rule.says ?? null, matches: unfinished ? [] : found.matches, incomplete: unfinished ? found.incomplete : [], error_rows: found.error_rows, changes: 0, held: 0, already: 0, shadowed: 0 };
  });
  const ruleIds = new Set(rules.map(({ rule }) => rule.id));
  const matched = summaries.map(summary => new Set(summary.matches));

  const changes = [];
  const held = [];
  const shadowed = [];
  const rows = [];
  records.forEach((record, at) => {
    const decided = new Map();
    rules.forEach(({ rule }, index) => {
      if (!matched[index].has(at)) return;
      for (const set of rule.set) {
        if (decided.has(set.field)) {
          shadowed.push({ row: at, id: idOf(record, at), field: set.field, rule: rule.id, by_rule: decided.get(set.field).rule });
          summaries[index].shadowed += 1;
          continue;
        }
        decided.set(set.field, { rule: rule.id, index, value: Object.hasOwn(set, 'from') ? readAt(record, set.from) ?? null : set.value });
      }
    });

    let next = record;
    const touched = [];
    for (const field of fields) {
      const now = readAt(record, pathOf(field.id));
      const holder = holderOf(record, field.id);
      const decision = decided.get(field.id);
      if (decision) {
        const summary = summaries[decision.index];
        if (sameValue(now, decision.value)) { summary.already += 1; continue; }
        if (!isEmpty(now) && !policy.mayReplace(ruleKind, holder?.kind ?? null)) {
          held.push({ row: at, id: idOf(record, at), field: field.id, value: now, held_by: holder ?? { kind: null, by: null }, rule: decision.rule, would_set: decision.value });
          summary.held += 1;
          continue;
        }
        changes.push({ row: at, id: idOf(record, at), field: field.id, from: now ?? null, to: decision.value, rule: decision.rule, group: rules[decision.index].group, reason: 'set' });
        summary.changes += 1;
        next = writeAt(next, pathOf(field.id), decision.value);
        if (provenance) next = writeAt(next, [...provenance.path, field.id], { [provenance.kind_key]: ruleKind, [provenance.by_key]: decision.rule });
        touched.push(field.id);
        continue;
      }
      if (holder?.kind === ruleKind && !isEmpty(now)) {
        changes.push({ row: at, id: idOf(record, at), field: field.id, from: now, to: null, rule: holder.by, group: null, reason: ruleIds.has(holder.by) ? 'no longer matched' : 'rule removed' });
        next = writeAt(writeAt(next, pathOf(field.id), undefined), [...provenance.path, field.id], undefined);
        touched.push(field.id);
      }
    }
    if (touched.length > 0) rows.push({ row: at, id: idOf(record, at), fields: touched, record: next });
  });

  return {
    total: records.length,
    changes,
    held,
    shadowed,
    rows,
    rules: summaries,
    incomplete: summaries.filter(summary => summary.incomplete.length > 0).map(({ group, rule, incomplete }) => ({ group, rule, incomplete })),
  };
}
