// tools/where-a-person-stands/do-work/where-a-person-stands.mjs
//
// Purpose
//   Where a person stands on one thing made for them (a title, a take, a plan, a file): agree, disagree, partly, or any
//   stand read-data/stances.json lists, with their own words for why. A stand is kept as one record per thing, of the
//   kind read-data/stances.json declares, so a change of mind is a new version of that record; the stands before it are
//   the record's earlier versions, read back here, never copied into the record.
//
// Non-negotiable invariants
//   1. A stand is only ever the person's: it is made only with answered_by "person", and `why` is kept exactly as given.
//      Silence is no stand: a thing with no stand record, or whose newest version takes the stand back, reads stance
//      null (unknown), never agree.
//   2. A stand names its thing by kind (a DATA word) and identity (do-work/artifact-ref.mjs, the one owner of how a
//      thing is identified): `artifact_ref` (`1f:` and 64 hex digits, with or without `file:`), or the thing itself as
//      `text`, `contains` (a part of a text) or `view` (any JSON) with the `fold` its owner declares. A name is not an
//      identity and is refused, so two names for one file are one stand. One record per kind and identity.
//   3. The newest version governs: a record's history (its versions as the records door's records:history pages them,
//      newest first) is ordered by `version`, the newest is the stand, and every older one is an earlier stand, oldest
//      first. A deleted version (a tombstone) is the stand taken back. A history whose last page still has `next` is
//      incomplete and says so: earlier stands it did not read are unknown, never none.
//   4. A reload of stands kept elsewhere (planReload) writes each earlier stand as an earlier version of the same
//      record, oldest first, and says how many records changed identity and which ones the fold made one.
//   5. This file names no stand, kind or word: they are DATA in read-data/stances.json.
//   6. Words said elsewhere are kept only when they are there: given the text of the source they came from (a chat
//      export, a transcript, a note), `why` must appear in it literally, at or after the line named (in a JSON-lines
//      source, also as its JSON-escaped form), or nothing is kept. The record then names where they were said
//      (`said_from`: the source's name, the BLAKE3 identity of its bytes, the byte range and line), so anyone can check
//      the words against the file. A reload checks every stand it carries (the earlier ones too) against its own source,
//      lists a row any of whose words are not there as unverified by its record id, never writes it, and writes no
//      version it was told is already kept.
//   7. A stand may name one rule (`rule`) of the person's rules: an agree on an exact text then waives that rule on that
//      text alone. It is its own record (the rule is part of its id), never a stand on the whole thing.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import stanceData from '../read-data/stances.json' with { type: 'json' };
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { artifactRef, bytesRef } from './artifact-ref.mjs';

const STANCES = new Map(stanceData.stances.map(row => [row.id, row]));
const WORDS = stanceData.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const IDENTITY = /^(?:file:)?(1f:[0-9a-f]{64})$/;
const RULE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class StanceRefusal extends Error {}

/** The stands a person can take. */
export const stanceChoices = () => stanceData.stances.map(({ id, label }) => ({ id, label }));

/** The content identity a ref names (`1f:<hex>`), or a refusal saying what to send. */
export function artifactOf(ref) {
  const found = typeof ref === 'string' ? IDENTITY.exec(ref.trim()) : null;
  if (!found) throw new StanceRefusal(WORDS.refused_ref);
  return found[1];
}

const kindOf = kind => {
  if (typeof kind !== 'string' || !kind.trim() || kind.includes('/')) throw new StanceRefusal(WORDS.refused_kind);
  return kind;
};

// The identity a stand names: its ref, or the thing itself through the one identity owner.
function identityOf({ artifact_ref, text, contains, view, fold }) {
  if (artifact_ref !== undefined) return artifactOf(artifact_ref);
  if (view === undefined && typeof (text ?? contains) !== 'string') throw new StanceRefusal(WORDS.refused_ref);
  try { return artifactRef({ text, contains, view }, fold); } catch (error) { throw new StanceRefusal(`${WORDS.refused_thing} ${error.message}`); }
}

const ruleOf = rule => {
  if (rule !== undefined && (typeof rule !== 'string' || !RULE.test(rule))) throw new StanceRefusal(WORDS.refused_rule);
  return rule;
};

/** The id of the one record that keeps the stand on a thing of a kind (and, for a waiver, the one rule it names). */
export const stanceRecordId = (kind, ref, rule) => `${stanceData.id_prefix}${kindOf(kind)}:${artifactOf(ref)}${ruleOf(rule) === undefined ? '' : `${stanceData.rule_infix}${rule}`}`;

/**
 * Whether `why` appears literally in `source_text` (the whole text of the file the words came from), at or after line
 * `after_line`. In a JSON-lines source (`json_lines`, or a `source` name ending .jsonl) the JSON-escaped form is looked
 * for too and bound as it is in the bytes. Returns { ok, reason, binding: { source?, blake3, text, byte_start, byte_end,
 * line, encoding? } }: blake3 is the identity of the source's UTF-8 bytes, so the binding can be checked against the file.
 */
export function verbatimInSource(why, source_text, { after_line = 1, source, json_lines = typeof source === 'string' && source.endsWith('.jsonl') } = {}) {
  if (typeof why !== 'string' || !why || typeof source_text !== 'string') return { ok: false, reason: WORDS.unverified_missing };
  const bytes = utf8ToBytes(source_text), buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let from = 0;
  for (let line = 1; line < after_line && from >= 0; line += 1) from = buffer.indexOf(10, from) + 1 || -1;
  if (from < 0) return { ok: false, reason: fill(WORDS.unverified_short, { after_line }) };
  const forms = json_lines ? [why, JSON.stringify(why).slice(1, -1)] : [why];
  const text = forms.find(form => buffer.indexOf(Buffer.from(form, 'utf8'), from) >= 0);
  if (text === undefined) return { ok: false, reason: fill(after_line > 1 ? WORDS.unverified_after : WORDS.unverified_absent, { after_line }) };
  const byte_start = buffer.indexOf(Buffer.from(text, 'utf8'), from);
  return { ok: true, reason: '', binding: { ...(typeof source === 'string' ? { source } : {}), blake3: bytesRef(bytes), text, byte_start,
    byte_end: byte_start + Buffer.byteLength(text), line: after_line + buffer.subarray(from, byte_start).filter(byte => byte === 10).length,
    ...(text !== why ? { encoding: 'json-string' } : {}) } };
}

/**
 * The record that keeps a stand: { type, id, kind, artifact, text? | contains? | view?, stance, said?, why?, by, at }.
 * stance null takes the stand back (a version of the same record that says no stand is taken). Refuses anything but
 * the person's own stand.
 */
export function stanceRecord({ kind, artifact_ref, text, contains, view, fold, stance, why, answered_by, by = 'person', at = new Date().toISOString(),
  rule, source_text, source, after_line = 1 } = {}) {
  if (answered_by !== 'person') throw new StanceRefusal(WORDS.refused_answered_by);
  const artifact = identityOf({ artifact_ref, text, contains, view, fold });
  if (why !== undefined && typeof why !== 'string') throw new StanceRefusal(WORDS.refused_why);
  let said_from = null;
  if (source_text !== undefined) {
    const checked = verbatimInSource(why, source_text, { after_line, source });
    if (!checked.ok) throw new StanceRefusal(`${WORDS.refused_unverified} ${checked.reason}`);
    said_from = checked.binding;
  }
  if (stance !== null && !STANCES.has(stance)) throw new StanceRefusal(fill(WORDS.refused_stance, { stances: [...STANCES.keys()].join(', ') }));
  const row = stance === null ? null : STANCES.get(stance);
  const thing = view !== undefined ? { view } : typeof text === 'string' ? { text } : typeof contains === 'string' ? { contains } : {};
  return {
    type: stanceData.kind, id: stanceRecordId(kind, artifact, rule), kind, artifact, ...thing, ...(rule !== undefined ? { rule } : {}), stance,
    ...(row ? { said: row.said } : {}), ...(row && why?.trim() ? { why } : {}), ...(said_from ? { said_from } : {}), by, at,
  };
}

// One version as records:history gives it: { version, value, deleted, at }. A tombstone has value null.
const stand = ({ version, value, deleted, at }) => (deleted || !value
  ? { version, stance: null, said: null, why: null, by: null, at, deleted: true }
  : { version, stance: value.stance ?? null, said: value.said ?? null, why: value.why ?? null, by: value.by ?? null, at: value.at ?? at, deleted: false });

/**
 * Where the person stands on one thing, from its stance record's history: `versions` as records:history returns them
 * ({ version, value, deleted, at }, newest first; the versions of every page read, in any order, may be passed
 * together) and `next`, the last page's. Returns { id, kind, artifact, text? | contains? | view?, stance, said, why, by,
 * at, version, earlier: [{ version, stance, said, why, by, at, deleted }] (oldest first), complete }. No version, or a
 * newest version that is a tombstone or takes the stand back, reads stance null.
 */
export function standFrom({ versions = [], next = null } = {}) {
  if (!Array.isArray(versions) || versions.some(row => !row || !Number.isInteger(row.version) || row.version < 1)) {
    throw new StanceRefusal(WORDS.refused_history);
  }
  const byVersion = new Map(versions.map(row => [row.version, row]));
  const ordered = [...byVersion.values()].sort((a, b) => a.version - b.version);
  const complete = next === null;
  const newest = ordered.at(-1);
  if (!newest) return { id: null, kind: null, artifact: null, stance: null, said: null, why: null, by: null, at: null, version: null, earlier: [], complete };
  const named = [...ordered].reverse().find(row => row.value && !row.deleted)?.value ?? {};
  const thing = ['text', 'contains', 'view', 'rule'].filter(key => named[key] !== undefined).map(key => [key, named[key]]);
  const { deleted, ...now } = stand(newest);
  return { id: named.id ?? null, kind: named.kind ?? null, artifact: named.artifact ?? null, ...Object.fromEntries(thing),
    ...now, ...(deleted || now.stance === null ? { taken_back: true } : {}), earlier: ordered.slice(0, -1).map(stand), complete };
}

/**
 * Stands kept elsewhere, as the record versions to write: `stances` are rows { kind, text | contains | view, stance,
 * why?, by?, at, rule?, earlier?: [{ stance, why?, at, source?, after_line? }], ref?, source?, after_line? } and `fold`
 * the fold their owner declares. A row or an earlier stand naming a `source` that `sources` holds ({ <name>: <its whole
 * text> }) is kept only when its own words are literally there (stanceRecord); otherwise the row is listed in
 * summary.unverified, by the record id it would have been, and nothing of it is written. A version in `kept`
 * ([{ id, stance, why?, at }], what an earlier run already wrote) is not written again. Returns writes, one version each
 * ({ id, type, value }), every record's earlier stands first and oldest first, and summary: records and versions by kind,
 * how many rows' identity differs from their old `ref`, collisions (the records two or more rows became under the fold,
 * each with the rows' texts and times, so a merge is seen, never silent), already and unverified.
 */
export function planReload({ stances = [], fold, by = 'person', sources = {}, kept = [] } = {}) {
  const records = new Map(), unverified = [];
  const keyOf = version => JSON.stringify([version.id, version.stance ?? null, version.why ?? null, version.at ?? null]);
  const done = new Set(kept.map(keyOf));
  const saidIn = entry => (entry.source !== undefined
    ? { source: entry.source, source_text: sources[entry.source] ?? null, after_line: entry.after_line ?? 1 } : {});
  let refsChanged = 0, already = 0;
  for (const row of stances) {
    const thing = { kind: row.kind, text: row.view === undefined ? row.text : undefined, contains: row.contains, view: row.view, fold, rule: row.rule };
    const entries = [...(row.earlier ?? []), row];
    let versions;
    try {
      versions = entries.map(entry => stanceRecord({
        ...thing, stance: entry.stance, why: entry.why, at: entry.at, by: entry.by ?? row.by ?? by, answered_by: 'person', ...saidIn(entry),
      }));
    } catch (error) {
      if (!entries.some(entry => entry.source !== undefined) || !(error instanceof StanceRefusal)) throw error;
      const named = entries.find(entry => entry.source !== undefined && !verbatimInSource(entry.why, sources[entry.source] ?? null,
        { after_line: entry.after_line ?? 1, source: entry.source }).ok) ?? row;
      unverified.push({ id: stanceRecordId(row.kind, identityOf(thing), row.rule), kind: row.kind, why: named.why ?? null, source: named.source ?? null,
        reason: error.message });
      continue;
    }
    const fresh = versions.filter(version => !done.has(keyOf(version)));
    already += versions.length - fresh.length;
    fresh.forEach(version => done.add(keyOf(version)));
    const { id, artifact } = versions.at(-1);
    if (typeof row.ref === 'string' && row.ref.replace(/^file:/, '') !== artifact) refsChanged += 1;
    const record = records.get(id) ?? { kind: row.kind, sources: [], versions: [] };
    record.sources.push({ ...(row.view !== undefined ? { view: true } : row.text !== undefined ? { text: row.text } : { contains: row.contains }), at: row.at, ...(row.ref ? { old_ref: row.ref } : {}) });
    record.versions.push(...fresh);
    records.set(id, record);
  }
  const writes = [], byKind = {};
  for (const [id, kept] of records) {
    const ordered = kept.versions.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    writes.push(...ordered.map(value => ({ id, type: stanceData.kind, value })));
    byKind[kept.kind] ??= { records: 0, versions: 0, rows: 0 };
    byKind[kept.kind].records += 1;
    byKind[kept.kind].versions += ordered.length;
    byKind[kept.kind].rows += kept.sources.length;
  }
  const collisions = [...records].filter(([, kept]) => kept.sources.length > 1)
    .map(([id, kept]) => ({ id, kind: kept.kind, rows: kept.sources }));
  return {
    writes,
    summary: { rows: stances.length, records: records.size, versions: writes.length, by_kind: byKind, refs_changed: refsChanged, collisions, already, unverified },
  };
}

/**
 * How many stands were read back, by kind and stand, how many carry earlier stands and how many were taken back: the
 * count the copy gate's `verdicts.mjs stances` printed. `stands` are standFrom answers or stance record values.
 */
export function countStands({ stands = [] } = {}) {
  const by_kind = {};
  for (const one of stands.filter(row => row?.stance)) by_kind[one.kind] = { ...by_kind[one.kind], [one.stance]: (by_kind[one.kind]?.[one.stance] ?? 0) + 1 };
  return { read: stands.length, by_kind, with_history: stands.filter(row => row?.earlier?.length).length,
    taken_back: stands.filter(row => row && !row.stance).length };
}
