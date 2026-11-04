// tools/decide-when-things-show/do-work/show-rules.mjs
//
// PURPOSE
//   The rows of this tool, run by tools/records-door/do-work/run-an-export.mjs over the person's own `show-rules` record
//   (show-rules.json `record`): see when things show, keep or change a rule, take a rule away, keep a type, take a type
//   away, switch a kept type on or off, share a kept type with someone, stop sharing it with them. A person, an AI and a
//   wake all run the same rows, so each change is the same change wherever it starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved store's: read-data/show-rules-store.mjs makeShowRules (trillion src/show-rules-store.mjs)
//      read, set and remove, with its edit rules and its refusals in its words, over changedRecord. Sharing is
//      a2e1365f33's two records, in its words (show-rules.json `sharing.words`). This file reads the records through the
//      door, hands them to that code, and answers what it would write.
//   2. Nothing here names a person, subject, control or type: show-rules.json and the request say them.
//   3. A run's key may not write a workspace record, so a change answers `keep`: the records to write, in order, each
//      with the value read as `expected`, written by whoever holds the person's write (the page's generic records write,
//      or a grant the person gives). A record changed meanwhile is not written over. Nothing here keeps a second store.
//   4. A share key is made here and answered once (`key`, to hand to the person); the grant keeps only its BLAKE3.
//   5. A shipped default is an overlay the reader lays under the person's record; it is never written into the record.
//      The rows lay tools/starting-set/shipped-defaults.json's show-rules default under the record the way trillion-rust
//      src/records/shipped_defaults.rs does (`by_id` types: the person's own entry wins; `switched` in_use: a shipped id
//      is on unless the person's `starting` holds it with on false), and take it back off before answering `keep`: a
//      shipped type the person did not change is not kept, and switching a shipped type is the person's
//      `starting.<id>.on` (false to switch it off; left out to switch it back on).
//
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import sharing from '../read-data/record-sharing.json' with { type: 'json' };
import shippedDefaults from '../../starting-set/shipped-defaults.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { typesOf, heldTypes } from '../../set-up-my-account/read-data/show-rules.mjs';
import { makeShowRules } from '../read-data/show-rules-store.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// The person's own door: the account owner, as the store's edit rules read the actor.
const OWN = { account_id: 'own' };
// The kind of record a wake reads for a switch it is asked to make: { type, on }, one per type.
export const USE_ASKED = 'show-type-use';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
let loaded = null;
async function rowFilter() {
  if (!loaded) loaded = (async () => { const filter = makeRowFilter({ operators, wasm }); await filter.load(); return filter.filterRowsByRulesNow; })();
  return loaded;
}

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

// The shipped default laid under the person's show-rules record, if one ships.
const SHIPPED = shippedDefaults.records.map(row => row.payload).find(one => one?.kind === 'shipped-default' && one.record === data.record) ?? null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const listOf = value => (Array.isArray(value) ? value : []);
const shippedTypes = () => (SHIPPED && (SHIPPED.merge?.by_id ?? []).includes('types') ? listOf(SHIPPED.value?.types).filter(type => object(type) && word(type.id)) : []);
const shippedSwitches = () => (SHIPPED ? (SHIPPED.merge?.switched ?? []).filter(one => one.field === 'in_use' && word(one.off_in)) : []);
/** The ids a shipped default switches on, each with where the person switches it off. */
const shippedOn = () => shippedSwitches().flatMap(({ off_in }) => listOf(SHIPPED.value.in_use).map(id => ({ id, off_in })));

/** Whether a type id is a shipped type the person keeps no copy of their own of. */
const isShipped = (id, record) => shippedTypes().some(type => type.id === id) && !listOf(record?.types).some(one => object(one) && one.id === id);

/** The person's record with the shipped default laid under it, as the engine's reader lays it; null stays null only when nothing ships. */
export function laidUnder(record) {
  const types = shippedTypes();
  const on = shippedOn();
  if (!types.length && !on.length) return record ?? null;
  const own = object(record) ? record : {};
  const ownTypes = listOf(own.types);
  const merged = [...types.filter(type => !ownTypes.some(one => object(one) && one.id === type.id)), ...ownTypes];
  const inUse = [...new Set([...on.filter(({ id, off_in }) => own[off_in]?.[id]?.on !== false && merged.some(type => type.id === id)).map(({ id }) => id), ...listOf(own.in_use)])];
  // The shipped switches are read into in_use here, so the store (which knows only starting-rule ids there) never sees them.
  const rest = { ...own };
  for (const off_in of new Set(on.map(one => one.off_in))) {
    if (!object(own[off_in])) continue;
    const switches = Object.fromEntries(Object.entries(own[off_in]).filter(([id]) => !on.some(one => one.id === id && one.off_in === off_in)));
    rest[off_in] = switches;
  }
  return { ...rest, ...(merged.length ? { types: merged } : {}), ...(inUse.length ? { in_use: inUse } : {}) };
}

/**
 * What the person's own record holds after a change made over laidUnder(before): the shipped types they did not
 * change are left out, and each shipped switch is kept as their `starting.<id>.on` instead of in their in_use.
 */
export function takenOff(after, before) {
  const types = shippedTypes();
  const on = shippedOn();
  if ((!types.length && !on.length) || !object(after)) return after;
  const own = object(before) ? before : {};
  const kept = listOf(after.types).filter(type => {
    const shipped = types.find(one => one.id === type.id);
    return !shipped || listOf(own.types).some(one => object(one) && one.id === type.id) || !same(type, shipped);
  });
  const shippedIds = new Set(on.map(({ id }) => id));
  const inUse = listOf(after.in_use).filter(id => !shippedIds.has(id) || kept.some(type => type.id === id));
  const next = { ...after };
  for (const { id, off_in } of on) {
    if (kept.some(type => type.id === id)) continue; // the person keeps their own copy: their in_use says
    const switches = object(next[off_in]) ? { ...next[off_in] } : {};
    if (listOf(after.in_use).includes(id)) delete switches[id];
    else switches[id] = { on: false };
    next[off_in] = switches;
  }
  delete next.types; delete next.in_use;
  return { ...next, ...(kept.length ? { types: kept } : {}), ...(inUse.length ? { in_use: inUse } : {}) };
}

/** The records the door holds for these labels: label → value, absent labels left out. */
async function readLabels(door, labels) {
  const { records } = await door.readWorkspace(labels);
  return new Map(labels.filter(label => records[label] !== undefined && records[label] !== null).map(label => [label, records[label]]));
}

/**
 * The moved store over what was read. Its writes are kept aside, in order, and each later read sees them, so several
 * changes in one run (a wake's switches) build on each other. `keep()` answers them against what was first read.
 */
async function storeOver(door, input) {
  const first = await readLabels(door, [data.record]);
  // The store reads the record with the shipped default laid under it; keep() takes the default back off.
  const held = new Map(first);
  const laid = laidUnder(first.get(data.record) ?? null);
  if (laid) held.set(data.record, laid);
  const writes = [];
  const records = {
    read: label => held.get(label) ?? null,
    write: rows => {
      for (const row of rows) { held.set(row.address_label, row.payload); writes.push(row.address_label); }
      return {};
    },
  };
  const at = nowOf(input);
  const store = makeShowRules({ records, filterRows: await rowFilter(), authority: 'personal', now: () => new Date(at) });
  const own = label => (label === data.record ? takenOff(held.get(label) ?? null, first.get(label) ?? null) : held.get(label) ?? null);
  const keep = () => [...new Set(writes)].map(label => ({ label, value: own(label), expected: first.get(label) ?? null }));
  return { store, keep, held, first };
}

const changeOnly = (input, field) => {
  if (!object(input)) throw new Error('The request is one object.');
  const { now: _now, ...rest } = input;
  return field ? { [field]: rest[field] } : rest;
};

/** tool:see-when-things-show (show-rules-store.mjs read) */
export async function seeWhenThingsShow(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const { store, first } = await storeOver(door, input);
  const answer = await store.read({ space_id: input.space_id ?? null });
  // Where each kept type's share is kept, for share-a-kept-show-type and stop-sharing-a-show-type to name; a type
  // that ships with Trillion and the person did not change says `shipped`.
  const shipped = id => isShipped(id, first.get(data.record));
  return { ...answer, types: answer.types.map(type => ({ ...type, ...(shipped(type.id) ? { shipped: true } : {}), grant: grantLabel(type.id) })) };
}

async function set(door, input, change) {
  const { store, keep } = await storeOver(door, input);
  const answer = await store.set(change, { actor: OWN });
  return { ...answer, keep: keep() };
}

/** tool:keep-a-show-rule (show-rules-store.mjs set { rule } | { starting }) */
export async function keepAShowRule(input = {}, { door } = {}) {
  const change = changeOnly(input);
  if (!object(change.rule) && !object(change.starting)) throw new Error('rule is { label, subject, when, effect, until? }; starting is { id, on } for a starting rule.');
  return set(door, input, object(change.starting) ? { starting: change.starting } : { rule: change.rule });
}

/** tool:take-a-show-rule-away (show-rules-store.mjs remove) */
export async function takeAShowRuleAway(input = {}, { door } = {}) {
  const change = changeOnly(input, 'id');
  const { store, keep } = await storeOver(door, input);
  const answer = await store.remove(change, { actor: OWN });
  return { ...answer, keep: keep() };
}

/** tool:keep-a-show-type (show-rules-store.mjs set { type }) */
export async function keepAShowType(input = {}, { door } = {}) {
  const change = changeOnly(input, 'type');
  if (!object(change.type)) throw new Error('A type is { id, label, inherits?, rules }: id is lowercase words joined by hyphens.');
  return set(door, input, change);
}

/** tool:take-a-show-type-away (show-rules-store.mjs set { remove_type }) */
export async function takeAShowTypeAway(input = {}, { door } = {}) {
  const change = changeOnly(input, 'remove_type');
  if (!word(change.remove_type)) throw new Error('remove_type names the id of a type you keep.');
  const id = change.remove_type;
  const switched = shippedOn().find(one => one.id === id);
  const { store, keep, first } = await storeOver(door, input);
  const before = first.get(data.record) ?? null;
  // A shipped type is every account's and cannot be taken away, only switched off; taking away the person's own copy
  // of one gives them the shipped one back, switched as their copy was.
  if (isShipped(id, before)) throw new Error(`${id} ships with Trillion for every account and cannot be taken away; switch it off with use: { type: "${id}", on: false }.`);
  const answer = await store.set(change, { actor: OWN });
  const kept = keep();
  if (switched && shippedTypes().some(type => type.id === id)) {
    for (const one of kept) {
      if (one.label !== data.record || !object(one.value)) continue;
      const switches = object(one.value[switched.off_in]) ? { ...one.value[switched.off_in] } : {};
      if (listOf(before?.in_use).includes(id)) delete switches[id]; else switches[id] = { on: false };
      one.value = { ...one.value, [switched.off_in]: switches };
    }
  }
  return { ...answer, keep: kept };
}

/**
 * tool:switch-a-kept-show-type (show-rules-store.mjs set { use }). Started by a wake with no `use`, it makes every switch
 * the person's `show-type-use` records ask for ({ type, on }, in id order), so writing one record switches one type.
 */
export async function switchAKeptShowType(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  let uses = object(input.use) ? [input.use] : null;
  if (!uses) {
    const asked = [];
    for await (const record of door.list({ type: USE_ASKED })) if (object(record.value)) asked.push({ id: record.id, use: { type: record.value.type, on: record.value.on } });
    uses = asked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(one => one.use);
    if (!uses.length) throw new Error(`use names type, the id of a profile you keep, and on: true to switch it on, false to switch it off; or write a ${USE_ASKED} record { type, on } for a wake to switch.`);
  }
  const { store, keep } = await storeOver(door, input);
  let answer;
  for (const use of uses) answer = await store.set({ use }, { actor: OWN });
  return { ...answer, ...(uses.length > 1 ? { said: `${uses.length} switches made; on now: ${answer.in_use.join(', ') || 'none'}.` } : {}), keep: keep() };
}

// A shared preset's two records (a2e1365f33): its copy, show-rules.json sharing.record_prefix + id = { label, types }, and
// its grant, record-sharing.json door_grant.record_prefix + that label = { record, people: [{ principal, key_blake3 }], changed_at }.
const copyLabel = id => `${data.sharing.record_prefix}${id}`;
const grantLabel = id => `${sharing.door_grant.record_prefix}${copyLabel(id)}`;
const words = data.sharing.words;
/** The people a grant names, read as the store holds it; anything that is not a grant names nobody. */
const peopleOf = value => (object(value) && Array.isArray(value.people)
  ? value.people.filter(person => object(person) && typeof person.principal === 'string' && typeof person.key_blake3 === 'string') : []);
/** A share key: the door's bearer prefix and 32 random bytes. */
const shareKey = () => `${sharing.door_grant.token_prefix}${randomBytes(32).toString('base64url')}`;

function shareInput(input) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!word(input.type)) throw new Error('type names the id of a preset you keep.');
  if (!word(input.principal)) throw new Error('principal names the person or account to share with.');
  if (input.grant !== grantLabel(input.type)) throw new Error(`grant is where the share of ${input.type} is kept: ${grantLabel(input.type)}.`);
  return { type: input.type, principal: input.principal.trim() };
}

/** tool:share-a-kept-show-type */
export async function shareAKeptShowType(input = {}, { door } = {}) {
  const { type, principal } = shareInput(input);
  const at = nowOf(input);
  const read = await readLabels(door, [data.record, grantLabel(type)]);
  const presets = typesOf(laidUnder(read.get(data.record) ?? null));
  const preset = presets.find(one => one.id === type);
  if (!preset) throw new Error(`${words.share_failed}: no preset ${type} is kept here. ${words.none}`);
  const before = read.get(grantLabel(type)) ?? null;
  const people = peopleOf(before);
  if (people.some(person => person.principal === principal)) throw new Error(fill(words.already, { principal }));
  const key = shareKey();
  const key_blake3 = bytesToHex(blake3(new TextEncoder().encode(key)));
  const label = copyLabel(type);
  // The copy is kept before the grant names anyone, so a key never reaches a record that is not there.
  return {
    shared: label,
    people: [...people.map(person => person.principal), principal],
    key,
    keep: [
      { label, value: { label: preset.label, types: heldTypes(presets, [preset.id]).map(id => presets.find(one => one.id === id)) } },
      { label: grantLabel(type), value: { record: label, people: [...people, { principal, key_blake3 }], changed_at: new Date(at).toISOString() }, expected: before },
    ],
    said: fill(words.added, { principal }),
  };
}

/** tool:stop-sharing-a-show-type */
export async function stopSharingAShowType(input = {}, { door } = {}) {
  const { type, principal } = shareInput(input);
  const at = nowOf(input);
  const before = (await readLabels(door, [grantLabel(type)])).get(grantLabel(type)) ?? null;
  const people = peopleOf(before);
  if (!people.some(person => person.principal === principal)) throw new Error(`${type} is not shared with ${principal}.`);
  const left = people.filter(person => person.principal !== principal);
  return {
    people: left.map(person => person.principal),
    keep: [{ label: grantLabel(type), value: { record: copyLabel(type), people: left, changed_at: new Date(at).toISOString() }, expected: before }],
    said: `${words.remove}: ${principal}.`,
  };
}
