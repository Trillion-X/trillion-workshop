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
//   3. The newest version governs: versions are ordered by `at`, and every older one is an earlier stand, oldest first.
//   4. A reload of stands kept elsewhere (planReload) writes each earlier stand as an earlier version of the same
//      record, oldest first, and says how many records changed identity and which ones the fold made one.
//   5. This file names no stand, kind or word: they are DATA in read-data/stances.json.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import stanceData from '../read-data/stances.json' with { type: 'json' };
import { artifactRef } from './artifact-ref.mjs';

const STANCES = new Map(stanceData.stances.map(row => [row.id, row]));
const WORDS = stanceData.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const IDENTITY = /^(?:file:)?(1f:[0-9a-f]{64})$/;

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

/** The id of the one record that keeps the stand on a thing of a kind. */
export const stanceRecordId = (kind, ref) => `${stanceData.id_prefix}${kindOf(kind)}:${artifactOf(ref)}`;

/**
 * The record that keeps a stand: { type, id, kind, artifact, text? | contains? | view?, stance, said?, why?, by, at }.
 * stance null takes the stand back (a version of the same record that says no stand is taken). Refuses anything but
 * the person's own stand.
 */
export function stanceRecord({ kind, artifact_ref, text, contains, view, fold, stance, why, answered_by, by = 'person', at = new Date().toISOString() } = {}) {
  if (answered_by !== 'person') throw new StanceRefusal(WORDS.refused_answered_by);
  const artifact = identityOf({ artifact_ref, text, contains, view, fold });
  if (why !== undefined && typeof why !== 'string') throw new StanceRefusal(WORDS.refused_why);
  if (stance !== null && !STANCES.has(stance)) throw new StanceRefusal(fill(WORDS.refused_stance, { stances: [...STANCES.keys()].join(', ') }));
  const row = stance === null ? null : STANCES.get(stance);
  const thing = view !== undefined ? { view } : typeof text === 'string' ? { text } : typeof contains === 'string' ? { contains } : {};
  return {
    type: stanceData.kind, id: stanceRecordId(kind, artifact), kind, artifact, ...thing, stance,
    ...(row ? { said: row.said } : {}), ...(row && why?.trim() ? { why } : {}), by, at,
  };
}

// A version as a store hands it back: the record value itself, or wrapped in { value } or { payload }.
const valueOf = version => (version && typeof version === 'object' ? version.value ?? version.payload ?? version : null);
const stand = value => ({ stance: value.stance ?? null, said: value.said ?? null, why: value.why ?? null, by: value.by ?? null, at: value.at ?? null });

/**
 * Where the person stands on each thing, from the versions of its stance records (any order, any number of things):
 * [{ id, kind, artifact, text?, contains?, view?, stance, said, why, by, at, earlier: [{ stance, said, why, by, at }] }]:
 * the newest version is the stand, and every older version is in `earlier`, oldest first. With `artifact_ref` (and
 * `kind`), only that thing, and a thing with no record reads stance null.
 */
export function standsFrom(versions = [], { artifact_ref, kind } = {}) {
  const wanted = artifact_ref === undefined ? null : artifactOf(artifact_ref);
  const byRecord = new Map();
  for (const value of versions.map(valueOf)) {
    if (!value || value.type !== stanceData.kind || typeof value.artifact !== 'string' || typeof value.id !== 'string') continue;
    if ((wanted && value.artifact !== wanted) || (kind !== undefined && value.kind !== kind)) continue;
    byRecord.set(value.id, [...(byRecord.get(value.id) ?? []), value]);
  }
  if (wanted && !byRecord.size) return [{ kind: kind ?? null, artifact: wanted, stance: null, said: null, why: null, by: null, at: null, earlier: [] }];
  return [...byRecord].map(([id, kept]) => {
    const ordered = [...kept].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    const newest = ordered.at(-1);
    const thing = ['text', 'contains', 'view'].filter(key => newest[key] !== undefined).map(key => [key, newest[key]]);
    return { id, kind: newest.kind ?? null, artifact: newest.artifact, ...Object.fromEntries(thing), ...stand(newest), earlier: ordered.slice(0, -1).map(stand) };
  });
}

/**
 * Stands kept elsewhere, as the record versions to write: `stances` are rows { kind, text | contains | view, stance,
 * why?, by?, at, earlier?: [{ stance, why?, at }], ref? } and `fold` the fold their owner declares. Returns writes, one
 * version each ({ id, type, value }), every record's earlier stands first and oldest first, and summary: records and
 * versions by kind, how many rows' identity differs from their old `ref`, and collisions, the records two or more rows
 * became under the fold (each with the rows' texts and times), so a merge is seen, never silent.
 */
export function planReload({ stances = [], fold, by = 'person' } = {}) {
  const records = new Map();
  let refsChanged = 0;
  for (const row of stances) {
    const thing = { kind: row.kind, text: row.view === undefined ? row.text : undefined, contains: row.contains, view: row.view, fold };
    const versions = [...(row.earlier ?? []), row].map(entry => stanceRecord({
      ...thing, stance: entry.stance, why: entry.why, at: entry.at, by: entry.by ?? row.by ?? by, answered_by: 'person',
    }));
    const { id, artifact } = versions.at(-1);
    if (typeof row.ref === 'string' && row.ref.replace(/^file:/, '') !== artifact) refsChanged += 1;
    const kept = records.get(id) ?? { kind: row.kind, sources: [], versions: [] };
    kept.sources.push({ ...(row.view !== undefined ? { view: true } : row.text !== undefined ? { text: row.text } : { contains: row.contains }), at: row.at, ...(row.ref ? { old_ref: row.ref } : {}) });
    kept.versions.push(...versions);
    records.set(id, kept);
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
    summary: { rows: stances.length, records: records.size, versions: writes.length, by_kind: byKind, refs_changed: refsChanged, collisions },
  };
}
