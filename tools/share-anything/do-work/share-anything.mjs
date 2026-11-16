// tools/share-anything/do-work/share-anything.mjs
//
// Purpose: The one sharing tool (`tool:share-anything`): share anything of the person's, from one record or one piece of text to a
// list, a whole collection of records, with a named person, an AI, or anyone holding a link, read-only; or let named people and AIs
// run some of the person's Workshop tools at the person's own door, with no copy on their computer, until a time or until stopped;
// show who has access; and stop it. It makes the share and keeps it, and nothing else: the engine reads exactly what a share names
// (trillion-rust src/account_rights/share_grant.rs) each time someone presents a key.
//
//   shareAnything(input, { door })   input { op: "share" | "stop" | "access", grant, thing?, with?, link?, can?, until?, origin?,
//                                     principal?, now? }; the one export the row runs.
//
// A run share holds no end in the engine, which reads none: `until` is the sharer's own condition, a row of kind data.run.end_kind
// at data.run.end_prefix + the grant, `{ grant, ends_at }`, and the sweep (end-shares-whose-condition-failed.mjs), which a wake
// the sharer switched on runs, withdraws the grant when the end has passed. Decision case
// source:bm8tZ3JhbnQtY29uZGl0aW9uLWluLWVuZ2luZS1jb2RlOndoZXJlLWNvbmRpdGlvbnMtbGl2ZS0yMDI2LTExLTE2.
//
// A share is the sharer's own workspace record at `grant` (record_prefix + the thing's label, read-data/share-label.mjs):
// { reach, title, can, people: [{ principal, key_blake3, added_at }], published, revoked_at, expires_at, changed_at }. A person,
// an AI or the link is each one entry of `people`, with a key of its own made here (token_prefix + 32 random bytes), handed back
// once and never kept: only its BLAKE3 is. No key is kept in the sharer's vault, so the share needs the sharer's signed-in
// session and nothing else, and a person or an AI recipient reads with the same key.
//
// Non-Negotiable Invariants:
// - A key is returned once, in the answer of the run that made it, and is in no record, log or error. A run sent again with its
//   request key answers its first answer (the engine's journal), so a retry never makes a second key.
// - A share lets people view (`can` ["view"], the default) or run the tools it names (`can` ["run"], data.run.can); anything else
//   is refused here, never narrowed later. A run share is kept by the engine's own keep operation (data.run.keep_operation) in
//   the sharer's vault, the only place the engine reads it from; this run never holds the sharer's key, and keeps nothing itself.
// - Stopping a person removes their entry, and stopping everyone sets revoked_at and empties people; the engine decides again on
//   every read, so the next read is refused.
// - The share is written, then read back; it is written again (up to `writes_tried`) when the readback lacks what this run added,
//   because another change to the record can land between this run's read and write. Each try has its own request key under
//   this run's, so a try the door answers twice is one write.
// - A text is kept as its own record before the share names it, so a key never reaches a record that is not there.
//
// Key Concepts: `thing` (read-data/share-label.mjs), `grant` (the label the run is granted, which the caller derives from the
// same rule), `people` (a person, an AI or the link; the link is the principal "link").
//
// Security Considerations: the row grants this run exactly one workspace label (`grant`), the list definitions it may read
// and the shared-text records it may write; it is never granted the records it shares, so what it shares is chosen by the
// reach it writes, which the engine bounds on every read.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from '../read-data/share-anything.json' with { type: 'json' };
import { grantOf, labelOf, listRecordId, reachOf, shapeOf } from '../read-data/share-label.mjs';

const words = data.words;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// The engine keeps the BLAKE3 of the key text as plain hex: the owner's identity without its `1f:` mark.
const hex = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice(3);
const newKey = () => `${data.token_prefix}${randomBytes(data.token_bytes).toString('base64url')}`;

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

// A share's end: a future time as ISO, or null. (Old trillion src/record-sharing.mjs createRecordShare: "expires_at must be a
// future time, or null for no expiry.")
function endOf(until, now) {
  if (until === undefined || until === null) return undefined;
  const at = typeof until === 'string' ? Date.parse(until) : NaN;
  if (!Number.isFinite(at) || at <= now) throw new Error(words.until);
  return new Date(at).toISOString();
}

function principalOf(value) {
  const principal = typeof value === 'string' ? value : object(value) ? value.principal : undefined;
  if (typeof principal !== 'string' || !principal.trim() || principal.length > data.most.principal_chars || /[\u0000-\u001f\u007f]/.test(principal)) {
    throw new Error(fill(words.principal, { most: data.most.principal_chars, link: data.link_principal }));
  }
  return principal.trim();
}

function originOf(origin) {
  if (origin === undefined) return null;
  if (typeof origin !== 'string' || !/^https:\/\/[^/\s]+$/.test(origin.replace(/\/+$/, ''))) throw new Error(words.origin);
  return origin.replace(/\/+$/, '');
}

const urlOf = (origin, key) => (origin ? `${origin}/share/${key}` : undefined);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The sharing record at `grant` as the door reads it, or null. */
async function readShare(door, grant) {
  const { records } = await door.readWorkspace([grant]);
  const held = records[grant];
  return object(held) ? held : null;
}

const peopleOf = held => (Array.isArray(held?.people) ? held.people.filter(person => object(person) && typeof person.principal === 'string' && typeof person.key_blake3 === 'string') : []);

/** The reach a thing names now: a list's is its definition and its rows' kind, which only the definition knows. */
async function reachNow(thing, door) {
  if (shapeOf(thing) !== 'list') return reachOf(thing);
  const id = listRecordId(thing.list);
  const definition = await door.read(data.list_kind, id);
  if (!object(definition) || typeof definition.row_type !== 'string' || !definition.row_type) throw new Error(fill(words.no_list, { list: thing.list }));
  return [{ type: data.list_kind, id }, { type: `${data.row_kind_prefix}${definition.row_type}` }];
}

async function titleOf(thing, door, given) {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, data.most.title_chars);
  const shape = shapeOf(thing);
  if (shape === 'list') {
    const definition = await door.read(data.list_kind, listRecordId(thing.list));
    const named = [definition?.label, definition?.title].find(name => typeof name === 'string' && name.trim());
    return (named ?? thing.list).slice(0, data.most.title_chars);
  }
  if (shape === 'text') return (typeof thing.title === 'string' && thing.title.trim() ? thing.title.trim() : thing.text.trim().split('\n')[0]).slice(0, data.most.title_chars);
  if (shape === 'items') return thing.title.trim().slice(0, data.most.title_chars);
  return thing.id;
}

// Writes the share, reads it back and writes again while `landed` says this run's change is missing.
async function keep(door, grant, change, landed, key) {
  for (let tried = 1; tried <= data.most.writes_tried; tried += 1) {
    const before = await readShare(door, grant);
    const value = change(before);
    await door.writeWorkspace([{ address_label: grant, payload: value }], { key: `${key}:${tried}` });
    const after = await readShare(door, grant);
    if (after && landed(after)) return after;
  }
  throw new Error(fill(words.kept_failed, { tried: data.most.writes_tried }));
}

function checkGrant(input, thing) {
  if (typeof input.grant !== 'string' || input.grant !== grantOf(thing)) throw new Error(fill(words.grant, { grant: grantOf(thing) }));
}

async function share(input, door) {
  const { thing } = input;
  const run = randomUUID();
  if (input.can !== undefined && !same(input.can, data.can)) throw new Error(words.can);
  checkGrant(input, thing);
  const now = nowOf(input);
  const ends = endOf(input.until, now);
  const origin = originOf(input.origin);
  const named = (input.with ?? []);
  if (!Array.isArray(named)) throw new Error(words.who);
  const principals = [...new Set(named.map(principalOf))];
  if (principals.includes(data.link_principal)) throw new Error(fill(words.principal, { most: data.most.principal_chars, link: data.link_principal }));
  const wantsLink = input.link === true;
  if (!principals.length && !wantsLink) throw new Error(words.who);
  const grant = input.grant;
  const label = labelOf(thing);
  const reach = await reachNow(thing, door);
  const title = await titleOf(thing, door, input.title ?? thing.title);
  const earlier = await readShare(door, grant);
  if (earlier && !same(earlier.reach, reach)) throw new Error(fill(words.different, { label }));
  const held = peopleOf(earlier).map(person => person.principal);
  for (const principal of [...principals, ...(wantsLink ? [data.link_principal] : [])]) {
    if (held.includes(principal)) throw new Error(fill(words.already, { principal: principal === data.link_principal ? 'the link' : principal }));
  }
  if (held.length + principals.length + (wantsLink ? 1 : 0) > data.most.people) throw new Error(fill(words.too_many, { most: data.most.people }));
  // The text is kept before the share names it.
  if (shapeOf(thing) === 'text') {
    await door.write([{ id: reach[0].id, type: data.text_kind, value: { title, text: thing.text } }], { key: `${run}:text` });
  }
  const at = new Date(now).toISOString();
  const keys = new Map([...principals, ...(wantsLink ? [data.link_principal] : [])].map(principal => [principal, newKey()]));
  const added = [...keys].map(([principal, key]) => ({ principal, key_blake3: hex(key), added_at: at }));
  const change = before => {
    const people = peopleOf(before).filter(person => !keys.has(person.principal));
    return {
      reach,
      title,
      can: data.can,
      people: [...people, ...added],
      published: true,
      revoked_at: null,
      expires_at: ends === undefined ? before?.expires_at ?? null : ends,
      changed_at: at,
    };
  };
  const landed = after => added.every(person => peopleOf(after).some(held => held.principal === person.principal && held.key_blake3 === person.key_blake3));
  const after = await keep(door, grant, change, landed, run);
  const link = wantsLink ? { key: keys.get(data.link_principal), ...(urlOf(origin, keys.get(data.link_principal)) ? { url: urlOf(origin, keys.get(data.link_principal)) } : {}) } : undefined;
  const people = principals.map(principal => ({ principal, key: keys.get(principal), ...(urlOf(origin, keys.get(principal)) ? { url: urlOf(origin, keys.get(principal)) } : {}) }));
  const said = [
    ...principals.map(principal => fill(words.added_person, { title, principal })),
    ...(wantsLink ? [fill(words.added_link, { title })] : []),
    ...(after.expires_at ? [fill(words.ends, { until: after.expires_at })] : []),
  ].join(' ');
  return { op: 'share', label, grant, title, reach, people, ...(link ? { link } : {}), expires_at: after.expires_at ?? null, said };
}

async function stop(input, door) {
  const run = randomUUID();
  const grant = input.grant;
  if (typeof grant !== 'string' || !grant.startsWith(data.record_prefix) || grant.length === data.record_prefix.length) throw new Error(fill(words.grant, { grant: `${data.record_prefix}<label>` }));
  const label = grant.slice(data.record_prefix.length);
  const now = nowOf(input);
  const at = new Date(now).toISOString();
  const earlier = await readShare(door, grant);
  if (!earlier) throw new Error(fill(words.no_share, { label }));
  const title = typeof earlier.title === 'string' ? earlier.title : label;
  if (input.principal === undefined) {
    await keep(door, grant, before => ({ ...before, people: [], published: true, revoked_at: at, changed_at: at }),
      after => after.revoked_at === at && peopleOf(after).length === 0, run);
    return { op: 'stop', label, grant, removed: peopleOf(earlier).map(person => person.principal), revoked_at: at, said: fill(words.stopped_all, { title }) };
  }
  const principal = principalOf(input.principal);
  if (!peopleOf(earlier).some(person => person.principal === principal)) throw new Error(fill(words.not_shared_with, { label, principal: principal === data.link_principal ? 'the link' : principal }));
  await keep(door, grant, before => ({ ...before, people: peopleOf(before).filter(person => person.principal !== principal), changed_at: at }),
    after => !peopleOf(after).some(person => person.principal === principal), run);
  return { op: 'stop', label, grant, removed: [principal], said: fill(words.stopped_person, { title, principal: principal === data.link_principal ? 'the link' : principal }) };
}

async function access(input, door) {
  const grant = input.grant;
  if (typeof grant !== 'string' || !grant.startsWith(data.record_prefix) || grant.length === data.record_prefix.length) throw new Error(fill(words.grant, { grant: `${data.record_prefix}<label>` }));
  const label = grant.slice(data.record_prefix.length);
  const now = nowOf(input);
  const held = await readShare(door, grant);
  if (!held) return { op: 'access', label, grant, shared: false, state: null, people: [], link: null, expires_at: null, said: fill(words.no_share, { label }) };
  const ended = typeof held.expires_at === 'string' && Date.parse(held.expires_at) <= now;
  const state = held.revoked_at ? 'stopped' : ended ? 'ended' : held.published === false ? 'stopped' : 'open';
  const people = peopleOf(held).map(person => ({ principal: person.principal, kind: person.principal === data.link_principal ? 'link' : 'person', added_at: person.added_at ?? null }));
  return {
    op: 'access', label, grant, shared: true, title: held.title ?? label, reach: held.reach ?? [], can: held.can ?? data.can, state,
    people: people.filter(person => person.kind === 'person'),
    link: people.find(person => person.kind === 'link') ? { on: state === 'open', added_at: people.find(person => person.kind === 'link').added_at } : null,
    expires_at: held.expires_at ?? null, revoked_at: held.revoked_at ?? null,
    said: words[state === 'open' ? 'open' : state],
  };
}

// ---- Run shares: named people and AIs run the tools a share names at the sharer's own door.

const runs = data.run;
const runsTools = input => same(input.can, runs.can);
const runPrincipalOf = value => {
  const principal = principalOf(value);
  if (!new RegExp(runs.principal_pattern).test(principal)) throw new Error(words.run_principal);
  return principal;
};

function runLabelOf(input) {
  const grant = input.grant;
  if (typeof grant !== 'string' || !grant.startsWith(data.record_prefix) || grant.length === data.record_prefix.length) throw new Error(fill(words.grant, { grant: `${data.record_prefix}<label>` }));
  return grant;
}

/** The run grant kept on `grant` now, as the engine lists it, or null. */
async function readRun(door, grant) {
  const { grants } = await door.sharing(runs.list_operation, { label: grant });
  return Array.isArray(grants) && object(grants[0]) ? grants[0] : null;
}

const endIdOf = grant => `${runs.end_prefix}${grant}`;
/** The end a run share holds as its sharer's own condition row, an ISO time, or null when it holds none. */
async function endHeld(door, grant) {
  const held = await door.read(runs.end_kind, endIdOf(grant));
  return object(held) && typeof held.ends_at === 'string' ? held.ends_at : null;
}

const keepRun = (door, grant, sharing, key) => door.sharing(runs.keep_operation, { label: grant, on: true, sharing }, { key });
const peopleKept = held => peopleOf(held).map(person => ({ principal: person.principal, key_blake3: person.key_blake3 }));

async function shareRun(input, door) {
  const grant = runLabelOf(input);
  const run = randomUUID();
  const tools = input.tools;
  if (!Array.isArray(tools) || !tools.length || tools.length > runs.most_tools || tools.some(tool => typeof tool !== 'string' || !tool) || new Set(tools).size !== tools.length) {
    throw new Error(fill(words.tools, { most: runs.most_tools }));
  }
  if (input.link === true) throw new Error(words.run_link);
  const identity = input.identity ?? runs.identity;
  const journal = input.journal ?? runs.journal;
  if (!runs.identities.includes(identity) || !runs.journals.includes(journal)) throw new Error(words.run_choice);
  const now = nowOf(input);
  const ends = endOf(input.until, now);
  const named = input.with ?? [];
  if (!Array.isArray(named)) throw new Error(words.who);
  const principals = [...new Set(named.map(runPrincipalOf))];
  if (!principals.length) throw new Error(words.who);
  const asked = { tools: [...tools].sort(), identity, journal };
  const earlier = await readRun(door, grant);
  const sameGrant = held => object(held) && same(held.tools, asked.tools) && held.identity === asked.identity && held.journal === asked.journal;
  if (earlier && !sameGrant(earlier.grant)) throw new Error(fill(words.different_tools, { label: grant }));
  const held = peopleKept(earlier);
  for (const principal of principals) {
    if (held.some(person => person.principal === principal)) throw new Error(fill(words.already, { principal }));
  }
  if (held.length + principals.length > data.most.people) throw new Error(fill(words.too_many, { most: data.most.people }));
  const keys = new Map(principals.map(principal => [principal, newKey()]));
  await keepRun(door, grant, { grant: asked, people: [...held, ...[...keys].map(([principal, key]) => ({ principal, key_blake3: hex(key) }))] }, run);
  if (ends !== undefined) await door.write([{ id: endIdOf(grant), type: runs.end_kind, value: { grant, ends_at: ends } }], { key: `${run}:end` });
  const expires_at = ends ?? await endHeld(door, grant);
  const said = [
    ...principals.map(principal => fill(words.added_runner, { principal, tools: asked.tools.join(', ') })),
    ...(expires_at ? [fill(words.ends, { until: expires_at })] : []),
  ].join(' ');
  return { op: 'share', can: runs.can, grant, tools: asked.tools, people: principals.map(principal => ({ principal, key: keys.get(principal) })), expires_at, said };
}

async function stopRun(input, door) {
  const grant = runLabelOf(input);
  const run = randomUUID();
  const earlier = await readRun(door, grant);
  if (!earlier) throw new Error(fill(words.no_share, { label: grant }));
  const people = peopleKept(earlier);
  const title = grant;
  if (input.principal === undefined) {
    await door.sharing(runs.keep_operation, { label: grant, on: false }, { key: run });
    await door.write([{ id: endIdOf(grant), type: runs.end_kind, value: null }], { key: `${run}:end` });
    return { op: 'stop', can: runs.can, grant, removed: people.map(person => person.principal), said: fill(words.stopped_all, { title }) };
  }
  const principal = runPrincipalOf(input.principal);
  if (!people.some(person => person.principal === principal)) throw new Error(fill(words.not_shared_with, { label: grant, principal }));
  const left = people.filter(person => person.principal !== principal);
  await keepRun(door, grant, { grant: earlier.grant, people: left }, run);
  return { op: 'stop', can: runs.can, grant, removed: [principal], said: fill(words.stopped_person, { title, principal }) };
}

async function accessRun(input, door) {
  const grant = runLabelOf(input);
  const held = await readRun(door, grant);
  if (!held) return { op: 'access', can: runs.can, grant, shared: false, state: null, tools: [], people: [], expires_at: null, said: fill(words.no_share, { label: grant }) };
  const expires_at = await endHeld(door, grant);
  const ended = expires_at !== null && Date.parse(expires_at) <= nowOf(input);
  const state = ended ? 'ended' : 'open';
  return {
    op: 'access', can: runs.can, grant, shared: true, state, tools: held.grant?.tools ?? [], identity: held.grant?.identity, journal: held.grant?.journal,
    people: peopleOf(held).map(person => ({ principal: person.principal, kind: 'person' })), expires_at, said: words[state],
  };
}

export async function shareAnything(input = {}, { door } = {}) {
  if (!object(input) || !['share', 'stop', 'access'].includes(input.op)) throw new Error(words.op);
  if (runsTools(input)) {
    if (input.op === 'share') return shareRun(input, door);
    return input.op === 'stop' ? stopRun(input, door) : accessRun(input, door);
  }
  if (input.op === 'share') return share(input, door);
  return input.op === 'stop' ? stop(input, door) : access(input, door);
}
