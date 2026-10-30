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
//   2. A stand names its thing by its content identity, `1f:` and 64 hex digits (BLAKE3), with or without `file:`
//      before it. A name is not an identity and is refused, so two names for one file are one stand.
//   3. The newest version governs: versions are ordered by `at`, and every older one is an earlier stand, oldest first.
//   4. This file names no stand, kind or word: they are DATA in read-data/stances.json.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import stanceData from '../read-data/stances.json' with { type: 'json' };

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

/** The id of the one record that keeps the stand on a thing. */
export const stanceRecordId = ref => `${stanceData.id_prefix}${artifactOf(ref)}`;

/**
 * The record that keeps a stand: { type, id, artifact, stance, said?, why?, by, at }. stance null takes the stand back
 * (a version of the same record that says no stand is taken). Refuses anything but the person's own stand.
 */
export function stanceRecord({ artifact_ref, stance, why, answered_by, by = 'person', at = new Date().toISOString() } = {}) {
  if (answered_by !== 'person') throw new StanceRefusal(WORDS.refused_answered_by);
  const artifact = artifactOf(artifact_ref);
  if (why !== undefined && typeof why !== 'string') throw new StanceRefusal(WORDS.refused_why);
  if (stance !== null && !STANCES.has(stance)) throw new StanceRefusal(fill(WORDS.refused_stance, { stances: [...STANCES.keys()].join(', ') }));
  const row = stance === null ? null : STANCES.get(stance);
  return {
    type: stanceData.kind, id: `${stanceData.id_prefix}${artifact}`, artifact, stance,
    ...(row ? { said: row.said } : {}), ...(row && why?.trim() ? { why } : {}), by, at,
  };
}

// A version as a store hands it back: the record value itself, or wrapped in { value } or { payload }.
const valueOf = version => (version && typeof version === 'object' ? version.value ?? version.payload ?? version : null);
const stand = value => ({ stance: value.stance ?? null, said: value.said ?? null, why: value.why ?? null, by: value.by ?? null, at: value.at ?? null });

/**
 * Where the person stands on each thing, from the versions of its stance records (any order, any number of things):
 * [{ artifact, stance, said, why, by, at, earlier: [{ stance, said, why, by, at }] }]: the newest version is the stand,
 * and every older version is in `earlier`, oldest first. With `artifact_ref`, only that thing, and a thing with no
 * record reads stance null.
 */
export function standsFrom(versions = [], artifact_ref) {
  const wanted = artifact_ref === undefined ? null : artifactOf(artifact_ref);
  const byThing = new Map();
  for (const value of versions.map(valueOf)) {
    if (!value || value.type !== stanceData.kind || typeof value.artifact !== 'string') continue;
    if (wanted && value.artifact !== wanted) continue;
    byThing.set(value.artifact, [...(byThing.get(value.artifact) ?? []), value]);
  }
  if (wanted && !byThing.has(wanted)) return [{ artifact: wanted, stance: null, said: null, why: null, by: null, at: null, earlier: [] }];
  return [...byThing].map(([artifact, kept]) => {
    const ordered = [...kept].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    const newest = ordered.at(-1);
    return { artifact, ...stand(newest), earlier: ordered.slice(0, -1).map(stand) };
  });
}
