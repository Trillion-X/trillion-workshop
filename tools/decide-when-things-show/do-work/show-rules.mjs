// tools/decide-when-things-show/do-work/show-rules.mjs
//
// PURPOSE
//   The rows of this tool, run by tools/records-door/do-work/run-an-export.mjs over the person's own `show-rules` record
//   (show-rules.json `record`): see when things show, keep or change a rule, take a rule away, keep a type, take a type
//   away, switch a kept type on or off, share a kept type, stop sharing. A person, an AI and a wake all run the same rows,
//   so each change is the same change wherever it starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's: every change is set-up-my-account/read-data/show-rules.mjs changedRecord (the
//      one change function show-rules-store.mjs set and remove call), each refusal in its words or the store's. This
//      file reads the record, hands it over, and answers what to keep.
//   2. Nothing here names a person, subject, control or type: show-rules.json and the request say them.
//   3. The record is read through the door (`workspace:read`, one exact label). A run's key may not write a workspace
//      record, so a change answers `keep`: the records to write, each with the value read as `expected`, written by
//      whoever holds the person's write (the page's own generic records write, or a grant the person gives). Nothing is
//      written here and no second store is kept.
//   4. A shipped default is an overlay the reader lays under the person's record; it is never written into the record.
//
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { changedRecord, everyRule, heldTypes, profileRules, typesOf } from '../../set-up-my-account/read-data/show-rules.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const words = list => (list ?? []).map(({ id, label, kind, choices }) => ({ id, label, ...(kind ? { kind } : {}), ...(choices ? { choices } : {}) }));
const current = (list, at) => list.filter(rule => !rule.until || Date.parse(rule.until) > at);
// The kind of record a wake reads for a switch it is asked to make: { type, on }, one per type.
export const USE_ASKED = 'show-type-use';

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

/** The person's show-rules record as the door holds it: an object, or null when they keep none yet. */
async function readRecord(door) {
  const { records } = await door.readWorkspace([data.record]);
  const value = records[data.record];
  if (value === undefined || value === null) return null;
  if (!object(value)) throw new Error(`${data.record} is not a show-rules record: it must be an object.`);
  return value;
}

const keepOf = (next, prior) => [{ label: data.record, value: next, expected: prior }];

// The answer show-rules-store.mjs set gives (rules, types, said), with the record to keep.
function answerOf(next, prior, at, extra) {
  return { ...extra, rules: current(everyRule(data, next), at), types: typesOf(next).map(type => type.id), keep: keepOf(next, prior) };
}

async function changed(door, input, change) {
  const at = nowOf(input);
  const prior = await readRecord(door);
  return { prior, next: changedRecord(data, prior, change, at, 'personal'), at };
}

/** tool:see-when-things-show (show-rules-store.mjs read) */
export async function seeWhenThingsShow(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const record = await readRecord(door);
  const at = nowOf(input);
  const spaceId = word(input.space_id) ? input.space_id.trim() : null;
  const rules = current([...everyRule(data, record), ...profileRules(data, record, spaceId)], at);
  return {
    rules,
    subjects: Object.fromEntries(Object.entries(data.subjects).map(([id, subject]) => [id, { label: subject.label, facts: words(subject.facts),
      ...(subject.allowed_effects ? { allowed_effects: subject.allowed_effects } : {}) }])),
    types: typesOf(record).map(type => ({ id: type.id, label: type.label ?? type.id, inherits: type.inherits ?? [], rules: type.rules ?? [], ...(type.scope != null ? { scope: type.scope } : {}) })),
    in_use: Array.isArray(record?.in_use) ? record.in_use : [],
    record: data.record,
    moment_facts: words(data.moment_facts),
    effects: words(data.effects),
    quick: words(data.quick),
    operators: (operators.operators ?? []).map(row => row.id ?? row).filter(Boolean),
    said: rules.some(rule => rule.on) ? `${rules.filter(rule => rule.on).length} rules are on.` : 'No rules are on: everything shows.',
  };
}

/** tool:keep-a-show-rule (show-rules-store.mjs set { rule } | { starting }) */
export async function keepAShowRule(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const change = object(input.starting) ? { starting: input.starting } : { save: input.rule };
  if (!change.starting && !object(change.save)) throw new Error('rule is { label, subject, when, effect, until? }; starting is { id, on } for a starting rule.');
  const { prior, next, at } = await changed(door, input, change);
  const rule = change.save ? next.rules.find(one => change.save.id ? one.id === change.save.id : !(prior?.rules ?? []).some(before => before.id === one.id)) : null;
  return answerOf(next, prior, at, { ...(rule ? { rule } : {}), said: rule ? `Kept: ${rule.label || rule.subject}.` : 'Changed.' });
}

/** tool:take-a-show-rule-away (show-rules-store.mjs remove) */
export async function takeAShowRuleAway(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (typeof input.id !== 'string' || !input.id) throw new Error('id is a rule id from read_show_rules.');
  const { prior, next, at } = await changed(door, input, { remove: input.id });
  return answerOf(next, prior, at, { said: 'Taken away.' });
}

/** tool:keep-a-show-type (show-rules-store.mjs set { type }) */
export async function keepAShowType(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!object(input.type)) throw new Error('A type is { id, label, inherits?, rules }: id is lowercase words joined by hyphens.');
  const at = nowOf(input);
  const prior = await readRecord(door);
  let type = input.type;
  const existing = typesOf(prior).find(one => one.id === type.id);
  // Omission preserves a nested policy; an explicit [] intentionally clears the profile override.
  if (existing && !Object.hasOwn(type, 'edit_rules') && Object.hasOwn(existing, 'edit_rules')) type = { ...type, edit_rules: existing.edit_rules };
  const next = changedRecord(data, prior, { type }, at, 'personal');
  return answerOf(next, prior, at, { said: `Kept the type ${type.label || type.id}.` });
}

/** tool:take-a-show-type-away (show-rules-store.mjs set { remove_type }) */
export async function takeAShowTypeAway(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (typeof input.remove_type !== 'string' || !input.remove_type) throw new Error('remove_type names the id of a type you keep.');
  const { prior, next, at } = await changed(door, input, { remove_type: input.remove_type });
  return answerOf(next, prior, at, { said: 'Changed.' });
}

/**
 * tool:switch-a-kept-show-type (show-rules-store.mjs set { use }). Started by a wake with no `use`, it makes every switch
 * the person's `show-type-use` records ask for ({ type, on }, in id order), so writing one record switches one type.
 */
export async function switchAKeptShowType(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  let uses = object(input.use) ? [input.use] : null;
  if (!uses) {
    uses = [];
    for await (const asked of door.list({ type: USE_ASKED })) if (object(asked.value)) uses.push({ id: asked.id, use: { type: asked.value.type, on: asked.value.on } });
    uses = uses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(one => one.use);
    if (!uses.length) throw new Error(`use names type, the id of a profile you keep, and on: true to switch it on, false to switch it off; or write a ${USE_ASKED} record { type, on } for a wake to switch.`);
  }
  const at = nowOf(input);
  const prior = await readRecord(door);
  let next = prior;
  for (const use of uses) next = changedRecord(data, next, { use }, at, 'personal');
  const last = uses.at(-1);
  return answerOf(next, prior, at, { in_use: next.in_use ?? [],
    said: uses.length === 1 ? `${last.on ? 'Switched on' : 'Switched off'} ${next.types.find(type => type.id === last.type)?.label ?? last.type}.`
      : `${uses.length} switches made; on now: ${(next.in_use ?? []).join(', ') || 'none'}.` });
}

// A shared preset's two records (show-rules.json `sharing`): show-types-shared:<id> = { label, types } and
// sharing:<that label> = { record, people: [{ principal, key_blake3 }], changed_at }.
const sharedLabel = id => `${data.sharing.record_prefix}${id}`;
const sharingLabel = id => `sharing:${sharedLabel(id)}`;

/** tool:share-a-kept-show-type */
export async function shareAKeptShowType(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!word(input.type)) throw new Error('type names the id of a preset you keep.');
  if (!Array.isArray(input.people) || !input.people.length || input.people.length > 100
    || input.people.some(one => !object(one) || !word(one.principal) || typeof one.key_blake3 !== 'string' || !/^[0-9a-f]{64}$/.test(one.key_blake3))) {
    throw new Error('people is everyone the preset is shared with: [{ principal, key_blake3 }], key_blake3 the BLAKE3 hex of the share key you hand them.');
  }
  if (new Set(input.people.map(one => one.principal)).size !== input.people.length) throw new Error('Each person is named once in people.');
  const at = nowOf(input);
  const record = await readRecord(door);
  const kept = typesOf(record);
  const preset = kept.find(type => type.id === input.type);
  if (!preset) throw new Error(`No profile ${input.type} is kept here; keep it with { type } first. Kept profiles: ${kept.map(one => one.id).join(', ') || 'none'}.`);
  // The preset is copied whole, with the presets it inherits.
  const types = heldTypes(kept, [preset.id]).map(id => kept.find(type => type.id === id));
  const label = sharedLabel(preset.id);
  return {
    shared: label,
    people: input.people.map(one => one.principal),
    keep: [
      { label, value: { label: preset.label ?? preset.id, types } },
      { label: sharingLabel(preset.id), value: { record: label, people: input.people.map(({ principal, key_blake3 }) => ({ principal, key_blake3 })), changed_at: new Date(at).toISOString() } },
    ],
    said: `Shared ${preset.label ?? preset.id} with ${input.people.map(one => one.principal).join(', ')}.`,
  };
}

/** tool:stop-sharing-a-show-type */
export async function stopSharingAShowType(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!word(input.type)) throw new Error('type names the id of a preset you share.');
  return {
    keep: [{ label: sharingLabel(input.type), value: null }, { label: sharedLabel(input.type), value: null }],
    said: `Stopped sharing ${input.type}.`,
  };
}
