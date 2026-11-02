// tools/write-public-share-files/read-data/shareable-copy.mjs (moved from Trillion's src/person-spaces.mjs shareableCopy)
//
// The copy of one record that leaves the person: only the fields its kind's rule lets out (share_from_private), at
// every depth the rule names, less the fields the person left out, and a field shared to match only as a mark from
// `match`, never its value.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A field leaves only when its kind's rule names it, at every depth; anything a rule does not name stays.
//   2. A left-out field leaves nothing; a match-only field leaves only `match(field, value)`, and when no `match` is
//      given the copy is refused rather than made with the value.
//   3. The copy's title is another copy of its source field: a left-out or match-only title field leaves no title.
//
//   shareableCopy(type, id, value, { leave_out?, match_only?, match? }, rules?) → { kind, private_ref, title, body }
//   rules: the share_from_private table of the caller that owns its record kinds; by default this tool's DATA, which
//   names the List rule only.
import data from './share-files.json' with { type: 'json' };

const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);

export function shareableCopy(type, id, value, { leave_out: leaveOut = [], match_only: matchOnly = [], match } = {}, rules = data.share_from_private) {
  const rule = rules[type];
  if (!rule) throw new Error(`A ${type ?? 'record'} cannot be shared into a space. What can: ${Object.keys(rules).join(', ')}, and files.`);
  const project = (given, nested) => {
    if (nested?.items && Array.isArray(given)) return given.map(item => project(item, nested.items));
    if (!nested?.fields || !given || typeof given !== 'object' || Array.isArray(given)) return given;
    return Object.fromEntries(nested.fields.filter(field => given[field] !== undefined).map(field => [field, project(given[field], nested.nested?.[field])]));
  };
  if (matchOnly.some(field => rule.fields.includes(field) && value[field] !== undefined && !leaveOut.includes(field)) && typeof match !== 'function') {
    throw new Error('Sharing a field to match only is not set up, so it was not shared.');
  }
  const body = Object.fromEntries(rule.fields.filter(field => value[field] !== undefined && !leaveOut.includes(field))
    .map(field => [field, matchOnly.includes(field) ? match(field, value[field]) : project(value[field], rule.nested?.[field])]));
  // The preview title is another copy of its source field. A hidden or match-only field cannot reappear there.
  const title = leaveOut.includes(rule.title?.[0]) || matchOnly.includes(rule.title?.[0]) ? null : pick(value, rule.title);
  return { kind: type, private_ref: id, title: typeof title === 'string' ? title.slice(0, 300) : null, body };
}
