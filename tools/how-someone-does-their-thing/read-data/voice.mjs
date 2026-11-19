// tools/how-someone-does-their-thing/read-data/voice.mjs (moved from Trillion-X/trillion src/voice.mjs)
//
// Purpose
//   The person's writing voice, learned from what they change. Every time they change words an AI wrote (a draft's
//   caption), the before and the after are kept as an edit; an AI that learns something from those edits and from what
//   the person sent saves it as a profile; every AI that drafts for them reads the profiles, the edits and what was
//   sent before it writes. Nothing here decides what a good voice is: the edits are the person's own, the profile is the
//   AI's reading of them, and both can be read, replaced and forgotten.
//   This file keeps no record and reads none. The person's store does that in its own language (the recipe
//   workflow:keep-how-someone-does-their-thing): the AI reads the profiles, edits and posted words there, passes what it
//   read as `earlier`, and writes back the `keep` rows these functions give.
//
// Non-negotiable invariants
//   1. The record types, the sizes and the profile's fields are DATA (voice.json). A field a profile may hold is a
//      row there; a field not named is refused in words, never kept.
//   2. An edit is kept only when the words really changed and the person changed them (the caller says so); the before
//      and after are the words themselves, cut to `max_edit_chars`, never a summary.
//   3. A profile is one record per kind of writing (`kind`, or `any_kind`); a save that names `expected_set_at` is
//      refused when the profile in `earlier` was saved since that read.
//   4. Only the newest `keep_edits` edits are kept. This file names no old edit: the store retires them (recipe, keep).
//   5. Nothing is sent anywhere and nothing is kept here.
//   6. A repeated edit is a word change found in at least `min_distinct_drafts` different drafts (never fewer than 2);
//      it is a proposal for the profile, never kept by itself. Finding them reads and keeps nothing: the edits come in
//      with the request (repeatedVoiceEdits).
//
import data from './voice.json' with { type: 'json' };

export class VoiceError extends Error {}

const text = value => typeof value === 'string' ? value : '';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const KIND = new RegExp(data.kind_pattern);
const FIELD_IDS = data.profile_fields.map(field => field.id);

const kindOf = kind => {
  if (kind === undefined || kind === null || kind === '') return data.any_kind;
  if (typeof kind !== 'string' || !KIND.test(kind)) throw new VoiceError(data.words.bad_kind);
  return kind;
};
const profileId = kind => `${data.profile_type}:${kind}`;

// Word changes between a draft and the person's words: runs removed, added or replaced, blind to case and edge punctuation.
const wordsOf = body => text(body).split(/\s+/).filter(Boolean);
const bare = word => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
function wordChanges(before, after) {
  const [left, right] = [wordsOf(before).map(bare), wordsOf(after).map(bare)];
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const found = [];
  let i = 0, j = 0, from = [], to = [];
  const flush = () => { const change = { from: from.filter(Boolean).join(' '), to: to.filter(Boolean).join(' ') }; if (change.from || change.to) found.push(change); from = []; to = []; };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { flush(); i++; j++; }
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) to.push(right[j++]);
    else from.push(left[i++]);
  }
  flush();
  return found;
}

/**
 * Shapes the profile of one kind of writing to keep. request: kind, name, fields (only the fields voice.json names; an
 * empty one removes that field), earlier (the voice-profile record the store holds for this kind, or null),
 * profiles_kept (how many voice-profile records the store holds), expected_set_at (the set_at read, or omitted), by.
 * Returns { profile, said, keep }: keep is the row the store writes, with its expected version (null when none existed).
 */
export function saveVoice({ kind, name, fields, earlier = null, profiles_kept: kept = 0, expected_set_at: expected, by = 'ai', now = () => new Date() } = {}) {
  const asked = kindOf(kind);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) throw new VoiceError(fill(data.words.unknown_field, { field: 'fields', fields: FIELD_IDS.join(', ') }));
  for (const field of Object.keys(fields)) if (!FIELD_IDS.includes(field)) throw new VoiceError(fill(data.words.unknown_field, { field, fields: FIELD_IDS.join(', ') }));
  if (!earlier && Number(kept) >= data.max_profiles) throw new VoiceError(fill(data.words.too_many_profiles, { max: String(data.max_profiles) }));
  if (expected !== undefined && (earlier?.set_at ?? null) !== expected) throw new VoiceError(fill(data.words.stale, { set_at: earlier?.set_at ?? 'never', expected }));
  const id = profileId(asked);
  const keptFields = { ...(earlier?.fields ?? {}) };
  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === '') delete keptFields[field];
    else keptFields[field] = text(value).slice(0, data.max_field_chars);
  }
  const profile = {
    profile_id: id, kind: asked,
    ...(name !== undefined ? { name: text(name).slice(0, 100) } : earlier?.name ? { name: earlier.name } : {}),
    fields: keptFields, set_at: now().toISOString(), set_by: by === 'person' ? 'person' : 'ai',
  };
  return { profile, said: `Saved the ${asked === data.any_kind ? 'general' : asked} voice profile.`, keep: [{ id, type: data.profile_type, value: profile }] };
}

/**
 * Shapes the person's change to words an AI wrote. request: kind, subject_id, before (the AI's words), after (theirs),
 * before_by, and newId/now for the record's id and time. Returns { edit, keep }: edit null and keep [] when the words did
 * not really change; the store keeps the newest keep_edits of them.
 */
export function keepAVoiceEdit({ kind, subject_id = null, before, after, before_by = null, now = () => new Date(), newId = () => crypto.randomUUID() } = {}) {
  const was = text(before).trim(), is = text(after).trim();
  if (!is || was === is) return { edit: null, keep: [] };
  const at = now().toISOString();
  const edit = {
    edit_id: `${data.edit_type}:${at}:${newId().replace(/-/g, '').slice(0, 10)}`, kind: kindOf(kind), subject_id, at,
    before: was.slice(0, data.max_edit_chars), after: is.slice(0, data.max_edit_chars), ...(before_by ? { before_by } : {}),
  };
  return { edit, keep: [{ id: edit.edit_id, type: data.edit_type, value: edit }] };
}

/**
 * The word changes the edits handed in repeat, each counted once per draft (subject_id, else the edit). Pure: it reads
 * and keeps nothing; the person's AI reads the edits from the store and sends them as `edits`.
 */
export function repeatedVoiceEdits({ edits, kind, min_distinct_drafts: least = data.repeated.min_distinct_drafts } = {}) {
  if (!Array.isArray(edits)) throw new VoiceError(data.words.no_edits);
  if (!Number.isInteger(least) || least < 2) throw new VoiceError(data.words.repeat_minimum);
  if (kind !== undefined && kind !== null && kind !== '' && (typeof kind !== 'string' || !KIND.test(kind))) throw new VoiceError(data.words.bad_kind);
  const asked = kind === undefined || kind === null || kind === '' ? undefined : kind;
  const kept = edits.filter(edit => edit && typeof edit === 'object' && (asked === undefined || edit.kind === asked));
  const seen = new Map();
  for (const edit of kept) for (const change of wordChanges(edit.before, edit.after)) {
    const key = `${change.from}\u0000${change.to}`, entry = seen.get(key) ?? seen.set(key, { ...change, drafts: new Set(), example: edit.edit_id }).get(key);
    entry.drafts.add(edit.subject_id ?? edit.edit_id);
  }
  const repeated = [...seen.values()].filter(entry => entry.drafts.size >= least)
    .map(({ from, to, drafts, example }) => ({ from, to, drafts: drafts.size, example_edit_id: example }))
    .sort((a, b) => b.drafts - a.drafts || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { edits: kept.length, min_distinct_drafts: least, repeated, said: repeated.length ? data.words.repeated : data.words.none_repeated };
}
