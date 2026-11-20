// tools/decide-when-things-show/do-work/show-rules.mjs
//
// PURPOSE
//   The rows of this tool, run by tools/workflows/do-work/run-a-function.mjs over the person's own `show-rules` record
//   (show-rules.json `record`, handed in as `records`): see when things show, keep or change a rule, take a rule away, keep a type, take a type
//   away, switch a kept type on or off, share a kept type with someone, stop sharing it with them. A person and an AI
//   run the same rows, so each change is the same change wherever it starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved store's: read-data/show-rules-store.mjs makeShowRules (trillion src/show-rules-store.mjs)
//      read, set and remove, with its edit rules and its refusals in its words, over changedRecord. Sharing is
//      a2e1365f33's two records, in its words (show-rules.json `sharing.words`). This file takes the records the caller
//      read from its own store and hands in as `records`, hands them to that code, and answers what it would write.
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
import { initSync, filterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import sharing from '../read-data/record-sharing.json' with { type: 'json' };
import { shippedFor, shippedOff, shippedUnder } from '../../starting-set/read-data/shipped-default.mjs';
import { typesOf, heldTypes } from '../../set-up-my-account/read-data/show-rules.mjs';
import { makeShowRules } from '../read-data/show-rules-store.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// The person's own account owner, as the store's edit rules read the actor.
const OWN = { account_id: 'own' };

// A row the caller hands over that is not an object reads as no facts, as the row filter always read it.
const asRecord = row => (row && typeof row === 'object' ? row : {});
let loaded = null;
async function rowFilter() {
  if (!loaded) loaded = (async () => {
    initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
    return ({ tree, fields, rows }) => filterRecords({ records: rows.map(asRecord), fields, tree });
  })();
  return loaded;
}

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

// The shipped default for the person's show-rules record, if one ships, and the parts of it the rows below ask about.
const SHIPPED = shippedFor(data.record);
const listOf = value => (Array.isArray(value) ? value : []);
const shippedTypes = () => (SHIPPED && (SHIPPED.merge?.by_id ?? []).includes('types') ? listOf(SHIPPED.value?.types).filter(type => object(type) && word(type.id)) : []);
/** The ids a shipped default switches on, each with where the person switches it off. */
const shippedOn = () => (SHIPPED ? (SHIPPED.merge?.switched ?? []).filter(one => one.field === 'in_use' && word(one.off_in)) : [])
  .flatMap(({ off_in }) => listOf(SHIPPED.value.in_use).map(id => ({ id, off_in })));
/** Whether a type id is a shipped type the person keeps no copy of their own of. */
const isShipped = (id, record) => shippedTypes().some(type => type.id === id) && !listOf(record?.types).some(one => object(one) && one.id === id);

/** The person's record with the shipped default laid under it, by the one reader of shipped defaults
 *  (tools/starting-set/read-data/shipped-default.mjs). */
export const laidUnder = record => shippedUnder(data.record, record);

/** What the person's own record holds after a change made over laidUnder(before) (shipped-default.mjs shippedOff). */
export const takenOff = (after, before) => shippedOff(data.record, after, before);

/** The records the caller handed in as `records` for these labels: label → value, absent labels left out. */
function readLabels(input, labels) {
  const given = object(input.records) ? input.records : {};
  return new Map(labels.filter(label => given[label] !== undefined && given[label] !== null).map(label => [label, given[label]]));
}

/**
 * The moved store over what was read. Its writes are kept aside, in order, and each later read sees them, so several
 * changes in one run build on each other. `keep()` answers them against what was first read.
 */
async function storeOver(input) {
  const first = readLabels(input, [data.record]);
  // The store reads the record with the shipped default laid under it; keep() takes the default back off.
  const held = Object.fromEntries(first);
  const laid = laidUnder(first.get(data.record) ?? null);
  if (laid) held[data.record] = laid;
  const at = nowOf(input);
  const store = makeShowRules({ held, filterRows: await rowFilter(), authority: 'personal', now: () => new Date(at) });
  // What the store would write, in order, each with the value read as expected (the record as it was handed in).
  const keep = () => store.changes().map(({ label, value }) => ({ label, value: label === data.record ? takenOff(value, first.get(label) ?? null) : value, expected: first.get(label) ?? null }));
  return { store, keep, first };
}

const changeOnly = (input, field) => {
  if (!object(input)) throw new Error('The request is one object.');
  const { now: _now, ...rest } = input;
  return field ? { [field]: rest[field] } : rest;
};

/** tool:see-when-things-show (show-rules-store.mjs read) */
export async function seeWhenThingsShow(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const { store, first } = await storeOver(input);
  const answer = await store.read({ space_id: input.space_id ?? null });
  // Where each kept type's share is kept, for share-a-kept-show-type and stop-sharing-a-show-type to name; a type
  // that ships with Trillion and the person did not change says `shipped`.
  const shipped = id => isShipped(id, first.get(data.record));
  return { ...answer, types: answer.types.map(type => ({ ...type, ...(shipped(type.id) ? { shipped: true } : {}), grant: grantLabel(type.id) })) };
}

async function set(input, change) {
  const { store, keep } = await storeOver(input);
  const answer = await store.set(change, { actor: OWN });
  return { ...answer, keep: keep() };
}

/** tool:keep-a-show-rule (show-rules-store.mjs set { rule } | { starting }) */
export async function keepAShowRule(input = {}) {
  const change = changeOnly(input);
  if (!object(change.rule) && !object(change.starting)) throw new Error('rule is { label, subject, when, effect, until? }; starting is { id, on } for a starting rule.');
  return set(input, object(change.starting) ? { starting: change.starting } : { rule: change.rule });
}

/** tool:take-a-show-rule-away (show-rules-store.mjs remove) */
export async function takeAShowRuleAway(input = {}) {
  const change = changeOnly(input, 'id');
  const { store, keep } = await storeOver(input);
  const answer = await store.remove(change, { actor: OWN });
  return { ...answer, keep: keep() };
}

/** tool:keep-a-show-type (show-rules-store.mjs set { type }) */
export async function keepAShowType(input = {}) {
  const change = changeOnly(input, 'type');
  if (!object(change.type)) throw new Error('A type is { id, label, inherits?, rules }: id is lowercase words joined by hyphens.');
  return set(input, change);
}

/** tool:take-a-show-type-away (show-rules-store.mjs set { remove_type }) */
export async function takeAShowTypeAway(input = {}) {
  const change = changeOnly(input, 'remove_type');
  if (!word(change.remove_type)) throw new Error('remove_type names the id of a type you keep.');
  const id = change.remove_type;
  const switched = shippedOn().find(one => one.id === id);
  const { store, keep, first } = await storeOver(input);
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
 * tool:switch-a-kept-show-type (show-rules-store.mjs set { use }). The switch is the request's `use` ({ type, on }); the run
 * reads no record but the person's show-rules setting and keeps nothing: `keep` is the record for the person's write.
 */
export async function switchAKeptShowType(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!object(input.use)) throw new Error('use names type, the id of a profile you keep, and on: true to switch it on, false to switch it off.');
  const { store, keep } = await storeOver(input);
  const answer = await store.set({ use: input.use }, { actor: OWN });
  return { ...answer, keep: keep() };
}

// A shared preset's two records (a2e1365f33): its copy, show-rules.json sharing.record_prefix + id = { label, types }, and
// its grant, record-sharing.json grant.record_prefix + that label = { record, people: [{ principal, key_blake3 }], changed_at }.
const copyLabel = id => `${data.sharing.record_prefix}${id}`;
const grantLabel = id => `${sharing.grant.record_prefix}${copyLabel(id)}`;
const words = data.sharing.words;
/** The people a grant names, read as the store holds it; anything that is not a grant names nobody. */
const peopleOf = value => (object(value) && Array.isArray(value.people)
  ? value.people.filter(person => object(person) && typeof person.principal === 'string' && typeof person.key_blake3 === 'string') : []);
/** A share key: the grant's token prefix and 32 random bytes. */
const shareKey = () => `${sharing.grant.token_prefix}${randomBytes(32).toString('base64url')}`;

function shareInput(input) {
  if (!object(input)) throw new Error('The request is one object.');
  if (!word(input.type)) throw new Error('type names the id of a preset you keep.');
  if (!word(input.principal)) throw new Error('principal names the person or account to share with.');
  if (input.grant !== grantLabel(input.type)) throw new Error(`grant is where the share of ${input.type} is kept: ${grantLabel(input.type)}.`);
  return { type: input.type, principal: input.principal.trim() };
}

/** The grant is the consent the share and the stop are checked against: it must be handed in (null when nobody holds it yet), never left out. */
function grantHandedIn(input, type) {
  const label = grantLabel(type);
  if (!object(input.records) || !(label in input.records)) throw new Error(`The grant ${label} must be handed in as records (null when nobody holds it yet); a share is never checked against a grant left out.`);
}

/** tool:share-a-kept-show-type */
export async function shareAKeptShowType(input = {}) {
  const { type, principal } = shareInput(input);
  grantHandedIn(input, type);
  const at = nowOf(input);
  const read = readLabels(input, [data.record, grantLabel(type)]);
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
export async function stopSharingAShowType(input = {}) {
  const { type, principal } = shareInput(input);
  grantHandedIn(input, type);
  const at = nowOf(input);
  const before = readLabels(input, [grantLabel(type)]).get(grantLabel(type)) ?? null;
  const people = peopleOf(before);
  if (!people.some(person => person.principal === principal)) throw new Error(`${type} is not shared with ${principal}.`);
  const left = people.filter(person => person.principal !== principal);
  return {
    people: left.map(person => person.principal),
    keep: [{ label: grantLabel(type), value: { record: copyLabel(type), people: left, changed_at: new Date(at).toISOString() }, expected: before }],
    said: `${words.remove}: ${principal}.`,
  };
}
