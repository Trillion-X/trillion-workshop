// tools/pour-example-rows-into-my-list/do-work/pour.mjs
//
// Pours a kit's example rows into a list the person already keeps for the same job. Each of the kit list's fields is
// matched to one of the person's fields: by the map they give, else the same id, else the same label, else a name in the
// field's `alike`. When fewer than `least_coverage` of the kit's fields match, nothing is poured and the answer names the
// fields that found no home, so the person makes the kit's own list or maps them. Otherwise the answer is the one
// the example rows to keep in their list (row ids `<row_type>:kit-<example id>`, so pouring twice changes nothing),
// each with expected null (a new row), leaving out rows already there. It stores nothing itself and knows no list.
//
//   node do-work/pour.mjs < { kit_list, into, field_map?, least_coverage?, already_there? }
//     -> { poured, coverage, matched, unmatched, left_out, keep, not_an_option, says }

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// A name as a person would say it: lowercase letters and digits, words joined, a plural s dropped.
const said = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(word => word.replace(/(?<=[a-z]{3})s$/, '')).join(' ');
const LEAST = 0.8;

class Refusal extends Error {}

function check(input) {
  if (!object(input)) throw new Refusal('Send one JSON object: { kit_list, into, field_map?, least_coverage?, already_there? }.');
  const { kit_list: kit, into } = input;
  if (!(object(kit) && Array.isArray(kit.fields) && kit.fields.length && Array.isArray(kit.example_rows))) throw new Refusal('kit_list must be one list of an item\'s kit: { list, fields: [{ id, label, alike? }], example_rows: [{ id, values }] }.');
  if (!(object(into) && /^list:[a-z0-9][a-z0-9-]*$/.test(into.list ?? '') && /^record:[a-z0-9][a-z0-9-]*$/.test(into.row_type ?? '') && Array.isArray(into.fields) && into.fields.length))
    throw new Refusal('into must be the person\'s own list: { list: "list:...", row_type: "record:...", fields: [{ id, label, options? }] }, read from their own store.');
  if (input.field_map !== undefined && !(object(input.field_map) && Object.values(input.field_map).every(value => value === null || nonempty(value)))) throw new Refusal('field_map must be { kit field id: your field id, or null to leave it out }.');
  const least = input.least_coverage ?? LEAST;
  if (!(typeof least === 'number' && least >= LEAST && least <= 1)) throw new Refusal(`least_coverage must be a share from ${LEAST} to 1.`);
  if (input.already_there !== undefined && !(Array.isArray(input.already_there) && input.already_there.every(nonempty))) throw new Refusal('already_there must list the row ids your list holds.');
  return { kit, into, map: input.field_map ?? {}, least, there: new Set(input.already_there ?? []) };
}

// The person's field each kit field goes to, or null.
function matchFields(kit, into, map) {
  const theirs = into.fields.filter(field => object(field) && nonempty(field.id));
  const byId = new Map(theirs.map(field => [field.id, field]));
  const taken = new Set();
  const matched = {};
  const reasons = {};
  const take = (kitId, field, why) => { matched[kitId] = field.id; reasons[kitId] = why; taken.add(field.id); };
  for (const field of kit.fields) {
    if (Object.hasOwn(map, field.id)) {
      const target = map[field.id];
      if (target === null) { matched[field.id] = null; reasons[field.id] = 'left out by the map'; continue; }
      if (!byId.has(target)) throw new Refusal(`field_map sends ${field.id} to ${target}, which is not a field of ${into.list}.`);
      take(field.id, byId.get(target), 'the map');
    }
  }
  const ways = [
    ['the same id', (field, their) => their.id === field.id],
    ['the same label', (field, their) => said(their.label) !== '' && (said(their.label) === said(field.label) || said(their.id) === said(field.label))],
    ['a name it goes by', (field, their) => (field.alike ?? []).some(name => said(name) === said(their.id) || said(name) === said(their.label))],
  ];
  for (const [why, fits] of ways) {
    for (const field of kit.fields) {
      if (Object.hasOwn(matched, field.id)) continue;
      const their = theirs.find(candidate => !taken.has(candidate.id) && fits(field, candidate));
      if (their) take(field.id, their, why);
    }
  }
  for (const field of kit.fields) if (!Object.hasOwn(matched, field.id)) matched[field.id] = null;
  return { matched, reasons, byId };
}

// A kit value as the person's field takes it: a choice outside their options is dropped, never guessed.
function fitted(value, field) {
  const options = Array.isArray(field?.options) ? field.options.map(option => (object(option) ? option.label ?? option.id : option)) : null;
  if (!options) return { value };
  const fits = item => options.includes(item);
  if (Array.isArray(value)) {
    const kept = value.filter(fits);
    return kept.length === value.length ? { value } : { value: kept.length ? kept : undefined, dropped: value.filter(item => !fits(item)) };
  }
  return fits(value) ? { value } : { value: undefined, dropped: [value] };
}

export function pour(input) {
  const { kit, into, map, least, there } = check(input);
  const { matched, reasons, byId } = matchFields(kit, into, map);
  const kitFields = kit.fields.map(field => field.id);
  const homed = kitFields.filter(id => matched[id]);
  const coverage = Math.round((homed.length / kitFields.length) * 100) / 100;
  const unmatched = kitFields.filter(id => !matched[id]);
  const matchedList = homed.map(id => ({ kit_field: id, your_field: matched[id], by: reasons[id] }));
  if (homed.length / kitFields.length < least) {
    return {
      poured: false, coverage, matched: matchedList, unmatched, left_out: [], keep: [], not_an_option: [],
      says: `${into.list} matches ${homed.length} of ${kitFields.length} fields of ${kit.list ?? 'the kit list'} (${Math.round(coverage * 100)}%), under the ${Math.round(least * 100)}% a pour needs. Fields with no home: ${unmatched.join(', ')}. Map them in field_map, or make the kit's own list from its fields and example rows.`,
    };
  }
  const keep = [];
  const not_an_option = [];
  const left_out = [];
  for (const example of kit.example_rows) {
    if (!(object(example) && nonempty(example.id) && object(example.values))) throw new Refusal('Every example row must be { id, values }.');
    const id = `${into.row_type}:kit-${example.id}`;
    if (there.has(id)) { left_out.push({ id, because: 'already in your list' }); continue; }
    const values = {};
    const dropped = [];
    for (const [kitField, value] of Object.entries(example.values)) {
      const target = matched[kitField];
      if (!target) continue;
      const made = fitted(value, byId.get(target));
      if (made.value !== undefined) values[target] = made.value;
      if (made.dropped) dropped.push(`${target}: ${made.dropped.join(', ')}`);
    }
    keep.push({ id, type: into.row_type, value: values, expected: null });
    if (dropped.length) not_an_option.push({ id, dropped });
  }
  return {
    poured: keep.length > 0, coverage, matched: matchedList, unmatched, left_out, keep, not_an_option,
    says: keep.length
      ? `${keep.length} example row${keep.length === 1 ? '' : 's'} to keep in ${into.list} (${Math.round(coverage * 100)}% of the kit's fields matched${unmatched.length ? `; left out: ${unmatched.join(', ')}` : ''}). Your own rows are not touched; your store refuses a row that appeared since you read your list.`
      : `Every example row is already in ${into.list}; nothing to pour.`,
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { input = undefined; }
  try {
    if (input === undefined) throw new Refusal('Standard input is not JSON: send one JSON object.');
    process.stdout.write(`${JSON.stringify(pour(input))}\n`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) await main();
