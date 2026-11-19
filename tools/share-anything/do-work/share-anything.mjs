// tools/share-anything/do-work/share-anything.mjs
//
// Purpose: The one sharing tool (`tool:share-anything`): share anything of the person's, from one record or one piece of text to a
// list, a whole collection of records, with a named person, an AI, or anyone holding a link, read-only; or let named people and AIs
// run some of the person's Workshop tools at the person's own door, with no copy on their computer, until stopped or until the
// end rule the person gives says (none by default); show who has access; change when a run share ends; and stop it. The tool does
// the work only a function can do here: it makes each key and keeps only its digest, works out who has access and what a share
// names, and judges the person's end rule. It reaches no database, no records door and no files (rule a-tool-is-only-what-the-
// store-cannot-do): the caller reads what the share needs from the person's own store, passes it in, and writes what comes back.
//
//   shareAnything(input)   input { op: "share" | "stop" | "access" | "end", grant, thing?, with?, link?, can?, until?, unused_days?,
//                          tools?, identity?, journal?, origin?, principal?, title?, now?, stored? } -> the answer, with `writes`:
//                          the records the caller must write in its own store, in order. Run by the workflow `run-a-function`
//                          command (do-work/run-a-function.mjs), which prints the answer; the one export the row runs.
//
//   stored  what the caller read from the person's store for this run, as the store holds it (null when it holds nothing):
//           { kept: the value at `grant` (a share record, or for a run share the grant the engine lists: { grant, people, ends,
//             last_used }), list: the list definition `list:<id>` when `thing` is a list, else absent }.
//   writes  [{ kind: "share" | "run-share" | "shared-text", address, value, expect }]. A write with value null withdraws the record at
//           address. `expect` is what `kept` (or the list) held when this was made: the caller writes only while its store still
//           holds `expect` (null when it holds nothing), and otherwise reads again and runs this tool again. A shared-text write is
//           content-addressed (its id is the BLAKE3 of its text), so it has no `expect`.
//
// How long a run share lasts is the person's choice, and by default it has no end (the owner, Nov 17 2026). The end rule the
// person gives (`until`, a future time, and/or `unused_days`, whole days with no use) is kept as `ends` beside the grant
// ({ until?, unused_days?, since }, `since` the time the rule was set); the store keeps it and the engine reads none of it.
// `op: "end"` sets a run share's rule again (neither given: it never ends), and a later share to more people keeps the rule it
// has unless it gives a new one. The sweep (end-shares-whose-condition-failed.mjs) judges those rules and returns the withdrawals.
// Decision case source:bm8tZ3JhbnQtY29uZGl0aW9uLWluLWVuZ2luZS1jb2RlOndoZXJlLWNvbmRpdGlvbnMtbGl2ZS0yMDI2LTExLTE2.
//
// A share is the sharer's own record at `grant` (record_prefix + the thing's label, read-data/share-label.mjs):
// { reach, title, can, people: [{ principal, key_blake3, added_at }], published, revoked_at, expires_at, changed_at }. A person,
// an AI or the link is each one entry of `people`, with a key of its own made here (token_prefix + 32 random bytes), handed back
// once and never kept: only its BLAKE3 is. No key is kept anywhere the caller writes, so the share needs the sharer's signed-in
// session and nothing else, and a person or an AI recipient reads with the same key.
//
// Non-Negotiable Invariants:
// - A key is returned once, in the answer of the run that made it, and is in no write, log or error. The writes hold digests only.
// - A share lets people view (`can` ["view"], the default) or run the tools it names (`can` ["run"], data.run); anything else is
//   refused here, never narrowed later. A run share's grant is returned as a `run-share` write; this tool never holds the sharer's
//   key and keeps nothing itself.
// - Stopping a person removes their entry, and stopping everyone sets revoked_at and empties people (a run share's everyone is a
//   withdrawal, value null); the engine decides again on every read, so the next read is refused.
// - Sharing with someone already named is refused; stop them first to give a new key.
// - A text is kept as its own record (a `shared-text` write) before the share names it, so a key never reaches a record that is not
//   there; the list a share names must be given in `stored.list`, or the run says so.
//
// Key Concepts: `thing` (read-data/share-label.mjs), `grant` (the label the run is granted, which the caller derives from the same
// rule), `people` (a person, an AI or the link; the link is the principal "link").
//
// Security Considerations: the answer never holds a key other than the one it hands back once; the writes hold only digests; the
// run's `stored` is what the caller chose to read, so the tool reaches nothing the caller did not give it.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { randomBytes } from 'node:crypto';
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

/** The value the caller read at `grant` (a share record or a run grant), or null. */
const keptOf = input => (object(input.stored?.kept) ? input.stored.kept : null);

const peopleOf = held => (Array.isArray(held?.people) ? held.people.filter(person => object(person) && typeof person.principal === 'string' && typeof person.key_blake3 === 'string') : []);

/** The write that puts `value` at `address` (null withdraws it), made on what the caller read as `expect`. */
const writeOf = (kind, address, value, expect) => ({ kind, address, value, expect: expect ?? null });

/** The reach a thing names now: a list's is its definition and its rows' kind, which only the definition knows (`stored.list`). */
function reachNow(thing, input) {
  if (shapeOf(thing) !== 'list') return reachOf(thing);
  const id = listRecordId(thing.list);
  const definition = input.stored?.list;
  if (!object(definition) || typeof definition.row_type !== 'string' || !definition.row_type) throw new Error(fill(words.no_list, { list: thing.list }));
  return [{ type: data.list_kind, id }, { type: `${data.row_kind_prefix}${definition.row_type}` }];
}

function titleOf(thing, input, given) {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, data.most.title_chars);
  const shape = shapeOf(thing);
  if (shape === 'list') {
    const definition = input.stored?.list;
    const named = [definition?.label, definition?.title].find(name => typeof name === 'string' && name.trim());
    return (named ?? thing.list).slice(0, data.most.title_chars);
  }
  if (shape === 'text') return (typeof thing.title === 'string' && thing.title.trim() ? thing.title.trim() : thing.text.trim().split('\n')[0]).slice(0, data.most.title_chars);
  if (shape === 'items') return thing.title.trim().slice(0, data.most.title_chars);
  return thing.id;
}

function checkGrant(input, thing) {
  if (typeof input.grant !== 'string' || input.grant !== grantOf(thing)) throw new Error(fill(words.grant, { grant: grantOf(thing) }));
}

function share(input) {
  const { thing } = input;
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
  const reach = reachNow(thing, input);
  const title = titleOf(thing, input, input.title ?? thing.title);
  const earlier = keptOf(input);
  if (earlier && !same(earlier.reach, reach)) throw new Error(fill(words.different, { label }));
  const held = peopleOf(earlier).map(person => person.principal);
  for (const principal of [...principals, ...(wantsLink ? [data.link_principal] : [])]) {
    if (held.includes(principal)) throw new Error(fill(words.already, { principal: principal === data.link_principal ? 'the link' : principal }));
  }
  if (held.length + principals.length + (wantsLink ? 1 : 0) > data.most.people) throw new Error(fill(words.too_many, { most: data.most.people }));
  const writes = [];
  // The text is kept before the share names it (content-addressed: its id is the BLAKE3 of the text, so no expect).
  if (shapeOf(thing) === 'text') writes.push({ kind: 'shared-text', address: reach[0].id, value: { title, text: thing.text }, expect: null, type: data.text_kind });
  const at = new Date(now).toISOString();
  const keys = new Map([...principals, ...(wantsLink ? [data.link_principal] : [])].map(principal => [principal, newKey()]));
  const added = [...keys].map(([principal, key]) => ({ principal, key_blake3: hex(key), added_at: at }));
  const people = peopleOf(earlier).filter(person => !keys.has(person.principal));
  const value = {
    reach,
    title,
    can: data.can,
    people: [...people, ...added],
    published: true,
    revoked_at: null,
    expires_at: ends === undefined ? earlier?.expires_at ?? null : ends,
    changed_at: at,
  };
  writes.push(writeOf('share', grant, value, earlier));
  const link = wantsLink ? { key: keys.get(data.link_principal), ...(urlOf(origin, keys.get(data.link_principal)) ? { url: urlOf(origin, keys.get(data.link_principal)) } : {}) } : undefined;
  const answered = principals.map(principal => ({ principal, key: keys.get(principal), ...(urlOf(origin, keys.get(principal)) ? { url: urlOf(origin, keys.get(principal)) } : {}) }));
  const said = [
    ...principals.map(principal => fill(words.added_person, { title, principal })),
    ...(wantsLink ? [fill(words.added_link, { title })] : []),
    ...(value.expires_at ? [fill(words.ends, { until: value.expires_at })] : []),
  ].join(' ');
  return { op: 'share', label, grant, title, reach, people: answered, ...(link ? { link } : {}), expires_at: value.expires_at ?? null, said, writes };
}

function stop(input) {
  const grant = input.grant;
  if (typeof grant !== 'string' || !grant.startsWith(data.record_prefix) || grant.length === data.record_prefix.length) throw new Error(fill(words.grant, { grant: `${data.record_prefix}<label>` }));
  const label = grant.slice(data.record_prefix.length);
  const now = nowOf(input);
  const at = new Date(now).toISOString();
  const earlier = keptOf(input);
  if (!earlier) throw new Error(fill(words.no_share, { label }));
  const title = typeof earlier.title === 'string' ? earlier.title : label;
  if (input.principal === undefined) {
    const value = { ...earlier, people: [], published: true, revoked_at: at, changed_at: at };
    return { op: 'stop', label, grant, removed: peopleOf(earlier).map(person => person.principal), revoked_at: at, said: fill(words.stopped_all, { title }),
      writes: [writeOf('share', grant, value, earlier)] };
  }
  const principal = principalOf(input.principal);
  if (!peopleOf(earlier).some(person => person.principal === principal)) throw new Error(fill(words.not_shared_with, { label, principal: principal === data.link_principal ? 'the link' : principal }));
  const value = { ...earlier, people: peopleOf(earlier).filter(person => person.principal !== principal), changed_at: at };
  return { op: 'stop', label, grant, removed: [principal], said: fill(words.stopped_person, { title, principal: principal === data.link_principal ? 'the link' : principal }),
    writes: [writeOf('share', grant, value, earlier)] };
}

function access(input) {
  const grant = input.grant;
  if (typeof grant !== 'string' || !grant.startsWith(data.record_prefix) || grant.length === data.record_prefix.length) throw new Error(fill(words.grant, { grant: `${data.record_prefix}<label>` }));
  const label = grant.slice(data.record_prefix.length);
  const now = nowOf(input);
  const held = keptOf(input);
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

/**
 * The end rule `input` gives a run share, kept as `ends`: { until?, unused_days?, since } with `since` the time it is set, null
 * when it gives neither (the share never ends), or undefined when it names no rule at all (a share kept again keeps its own).
 */
function endsOf(input, now, named = input.until !== undefined || input.unused_days !== undefined) {
  if (!named) return undefined;
  const until = endOf(input.until, now);
  const days = input.unused_days;
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1)) throw new Error(words.unused_days);
  if (until === undefined && (days === undefined || days === null)) return null;
  return { ...(until === undefined ? {} : { until }), ...(days === undefined || days === null ? {} : { unused_days: days }), since: new Date(now).toISOString() };
}
const untilOf = ends => (object(ends) && typeof ends.until === 'string' ? ends.until : null);
const withEnds = (sharing, ends) => (object(ends) ? { ...sharing, ends } : sharing);
const endsSaid = ends => [
  ...(untilOf(ends) ? [fill(words.ends, { until: ends.until })] : []),
  ...(object(ends) && Number.isInteger(ends.unused_days) ? [fill(words.ends_unused, { days: ends.unused_days })] : []),
];

const peopleKept = held => peopleOf(held).map(person => ({ principal: person.principal, key_blake3: person.key_blake3 }));

/** The run grant the caller read at `grant` (its listed shape), or null. */
const runKeptOf = input => keptOf(input);

function shareRun(input) {
  const grant = runLabelOf(input);
  const tools = input.tools;
  if (!Array.isArray(tools) || !tools.length || tools.length > runs.most_tools || tools.some(tool => typeof tool !== 'string' || !tool) || new Set(tools).size !== tools.length) {
    throw new Error(fill(words.tools, { most: runs.most_tools }));
  }
  if (input.link === true) throw new Error(words.run_link);
  const identity = input.identity ?? runs.identity;
  const journal = input.journal ?? runs.journal;
  if (!runs.identities.includes(identity) || !runs.journals.includes(journal)) throw new Error(words.run_choice);
  const now = nowOf(input);
  const given = endsOf(input, now);
  const named = input.with ?? [];
  if (!Array.isArray(named)) throw new Error(words.who);
  const principals = [...new Set(named.map(runPrincipalOf))];
  if (!principals.length) throw new Error(words.who);
  const asked = { tools: [...tools].sort(), identity, journal };
  const earlier = runKeptOf(input);
  const sameGrant = held => object(held) && same(held.tools, asked.tools) && held.identity === asked.identity && held.journal === asked.journal;
  if (earlier && !sameGrant(earlier.grant)) throw new Error(fill(words.different_tools, { label: grant }));
  const held = peopleKept(earlier);
  for (const principal of principals) {
    if (held.some(person => person.principal === principal)) throw new Error(fill(words.already, { principal }));
  }
  if (held.length + principals.length > data.most.people) throw new Error(fill(words.too_many, { most: data.most.people }));
  const keys = new Map(principals.map(principal => [principal, newKey()]));
  // A share given no rule keeps the one it has (a new share has none, so it never ends).
  const ends = given === undefined ? earlier?.ends : given;
  const people = [...held, ...[...keys].map(([principal, key]) => ({ principal, key_blake3: hex(key) }))];
  const value = withEnds({ grant: asked, people }, ends);
  const said = [...principals.map(principal => fill(words.added_runner, { principal, tools: asked.tools.join(', ') })), ...endsSaid(ends)].join(' ');
  return { op: 'share', can: runs.can, grant, tools: asked.tools, people: principals.map(principal => ({ principal, key: keys.get(principal) })),
    ends: object(ends) ? ends : null, expires_at: untilOf(ends), said, writes: [writeOf('run-share', grant, value, earlier)] };
}

function stopRun(input) {
  const grant = runLabelOf(input);
  const earlier = runKeptOf(input);
  if (!earlier) throw new Error(fill(words.no_share, { label: grant }));
  const people = peopleKept(earlier);
  const title = grant;
  if (input.principal === undefined) {
    return { op: 'stop', can: runs.can, grant, removed: people.map(person => person.principal), said: fill(words.stopped_all, { title }),
      writes: [writeOf('run-share', grant, null, earlier)] };
  }
  const principal = runPrincipalOf(input.principal);
  if (!people.some(person => person.principal === principal)) throw new Error(fill(words.not_shared_with, { label: grant, principal }));
  const left = people.filter(person => person.principal !== principal);
  const value = withEnds({ grant: earlier.grant, people: left }, earlier.ends);
  return { op: 'stop', can: runs.can, grant, removed: [principal], said: fill(words.stopped_person, { title, principal }),
    writes: [writeOf('run-share', grant, value, earlier)] };
}

function accessRun(input) {
  const grant = runLabelOf(input);
  const held = runKeptOf(input);
  if (!held) return { op: 'access', can: runs.can, grant, shared: false, state: null, tools: [], people: [], ends: null, expires_at: null, last_used: null, said: fill(words.no_share, { label: grant }) };
  const ends = object(held.ends) ? held.ends : null;
  const expires_at = untilOf(ends);
  const ended = expires_at !== null && Date.parse(expires_at) <= nowOf(input);
  const state = ended ? 'ended' : 'open';
  return {
    op: 'access', can: runs.can, grant, shared: true, state, tools: held.grant?.tools ?? [], identity: held.grant?.identity, journal: held.grant?.journal,
    people: peopleOf(held).map(person => ({ principal: person.principal, kind: 'person' })), ends, expires_at, last_used: held.last_used ?? null,
    said: [words[state], ...(ends ? endsSaid(ends) : [words.no_end])].join(' '),
  };
}

/** Set when a run share ends: the rule `until` and/or `unused_days` give, or none (it never ends); its people and keys stay. */
function endRun(input) {
  const grant = runLabelOf(input);
  const earlier = runKeptOf(input);
  if (!earlier) throw new Error(fill(words.no_share, { label: grant }));
  const ends = endsOf(input, nowOf(input), true);
  const value = withEnds({ grant: earlier.grant, people: peopleKept(earlier) }, ends);
  return { op: 'end', can: runs.can, grant, ends, expires_at: untilOf(ends), said: (ends ? endsSaid(ends) : [words.no_end]).join(' '),
    writes: [writeOf('run-share', grant, value, earlier)] };
}

export function shareAnything(input = {}) {
  if (!object(input) || !['share', 'stop', 'access', 'end'].includes(input.op)) throw new Error(words.op);
  if (runsTools(input)) {
    if (input.op === 'share') return shareRun(input);
    if (input.op === 'end') return endRun(input);
    return input.op === 'stop' ? stopRun(input) : accessRun(input);
  }
  if (input.op === 'end') throw new Error(words.end_run_only);
  if (input.op === 'share') return share(input);
  return input.op === 'stop' ? stop(input) : access(input);
}
