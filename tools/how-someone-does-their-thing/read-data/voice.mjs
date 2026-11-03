// tools/how-someone-does-their-thing/read-data/voice.mjs (moved from Trillion-X/trillion src/voice.mjs)
//
// Purpose
//   The person's writing voice, learned from what they change. Every time they change words an AI wrote (a draft's
//   caption), the before and the after are kept as an edit; an AI that learns something from those edits and from what
//   the person sent saves it as a profile; every AI that drafts for them reads the profiles, the edits and what was
//   sent before it writes. Nothing here decides what a good voice is: the edits are the person's own, the profile is the
//   AI's reading of them, and both can be read, replaced and forgotten. Their records are reached only through the
//   run's records door (tools/records-door); each row's rights name the kinds it may touch.
//
// Non-negotiable invariants
//   1. The record types, the sizes and the profile's fields are DATA (voice.json). A field a profile may hold is a
//      row there; a field not named is refused in words, never kept.
//   2. An edit is kept only when the words really changed and the person changed them (the caller says so); the before
//      and after are the words themselves, cut to `max_edit_chars`, never a summary.
//   3. A profile is one record per kind of writing (`kind`, or `any_kind`); saving it again replaces it, and a save that
//      names `expected_set_at` is refused when the profile was saved since that read.
//   4. Only the newest `keep_edits` edits are kept; older ones are retired a few at a time, never by reading them all.
//   5. Nothing is sent anywhere and nothing is kept outside the person's own records. forget removes a profile, one edit
//      or every edit (of one kind), and says how many.
//   6. A repeated edit is a word change found in at least `min_distinct_drafts` different drafts (never fewer than 2);
//      it is a proposal for the profile, never kept by itself.
//
import data from './voice.json' with { type: 'json' };

export class VoiceError extends Error {}

const text = value => typeof value === 'string' ? value : '';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const KIND = new RegExp(data.kind_pattern);
const FIELD_IDS = data.profile_fields.map(field => field.id);

// The newest `limit` ids of a kind, greatest id first (the door's order with none named).
async function idsOf(door, type, { limit }) {
  const ids = [];
  if (limit > 0) for await (const record of door.list({ type, fields: [], limit: Math.min(limit, 999) })) if (ids.push(record.id) >= limit) break;
  return ids;
}

// The words the person sent: their newest records of `data.sent.type` in `data.sent.status`, read from those records.
async function sentFrom(door, { limit }) {
  const { type, status, text_field: field, scan } = data.sent, rows = [];
  let seen = 0;
  for await (const { value } of door.list({ type, fields: ['post_id', 'status', field, 'sent_at', 'updated_at'], limit: scan })) {
    if (value?.status === status) rows.push({ id: value.post_id, kind: type, text: value[field], at: value.sent_at ?? value.updated_at });
    if (rows.length >= limit || ++seen >= scan) break;
  }
  return rows;
}

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
 * door:  the person's records door (read, list, write), from tools/records-door.
 * now:   () → Date.
 * newId: () → unique text.
 * sent:  ({ kind, limit }) → [{ text, at, id }] of words the person sent; by default their posted posts.
 */
export function makeVoice({ door, now = () => new Date(), newId = () => crypto.randomUUID(), sent = query => sentFrom(door, query) }) {
  const kindOf = kind => {
    if (kind === undefined || kind === null || kind === '') return data.any_kind;
    if (typeof kind !== 'string' || !KIND.test(kind)) throw new VoiceError(data.words.bad_kind);
    return kind;
  };
  const profileId = kind => `${data.profile_type}:${kind}`;
  const readProfile = id => door.read(data.profile_type, id);
  const readEdit = id => door.read(data.edit_type, id);
  // A kind's profile is read by its id; all of them are one page of at most `max_profiles`, a number save() holds the account to.
  const profilesOf = async kind => (kind !== undefined ? [await readProfile(profileId(kind))] : await Promise.all((await idsOf(door, data.profile_type, { limit: data.max_profiles })).map(readProfile))).filter(Boolean);
  const editsOf = async (kind, limit) => (await Promise.all((await idsOf(door, data.edit_type, { limit })).map(readEdit))).filter(edit => edit && (kind === undefined || edit.kind === kind));

  /** Keeps what the person changed. Returns the edit kept, or null when nothing really changed. */
  async function recordEdit({ kind, subject_id = null, before, after, before_by = null }) {
    const was = text(before).trim(), is = text(after).trim();
    if (!is || was === is) return null;
    const at = now().toISOString();
    const edit = {
      edit_id: `${data.edit_type}:${at}:${newId().replace(/-/g, '').slice(0, 10)}`, kind: kindOf(kind), subject_id, at,
      before: was.slice(0, data.max_edit_chars), after: is.slice(0, data.max_edit_chars), ...(before_by ? { before_by } : {}),
    };
    await door.write([{ id: edit.edit_id, type: data.edit_type, value: edit }]);
    const old = (await idsOf(door, data.edit_type, { limit: data.keep_edits + 20 })).slice(data.keep_edits);
    if (old.length) await door.write(old.map(id => ({ id, type: data.edit_type, value: null })));
    return edit;
  }

  /** Everything an AI reads before writing for this person. */
  async function read({ kind, limit } = {}) {
    const asked = kind === undefined || kind === null || kind === '' ? undefined : kindOf(kind);
    const profiles = (await profilesOf(asked)).map(profile => ({ profile_id: profile.profile_id, kind: profile.kind, name: profile.name ?? null, fields: profile.fields, set_at: profile.set_at, set_by: profile.set_by }));
    const edits = await editsOf(asked, Math.min(Math.max(Math.floor(Number(limit) || data.read.edits), 1), 50));
    const words = (await sent({ kind: asked, limit: data.read.sent })).map(row => ({ ...row, text: text(row.text).slice(0, data.read.sent_chars) }));
    return {
      how_to_use: data.words.how_to_use, fields: data.profile_fields, profiles, ...(profiles.length ? {} : { said: data.words.no_profile }),
      edits: edits.map(({ edit_id, kind: editKind, before, after, at, before_by }) => ({ edit_id, kind: editKind, before, after, at, ...(before_by ? { before_by } : {}) })), sent: words,
    };
  }

  /** Saves what an AI learned: one profile per kind. fields holds only the fields voice.json names. */
  async function save({ kind, name, fields, expected_set_at: expected } = {}, by = 'ai') {
    const asked = kindOf(kind);
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) throw new VoiceError(fill(data.words.unknown_field, { field: 'fields', fields: FIELD_IDS.join(', ') }));
    for (const field of Object.keys(fields)) if (!FIELD_IDS.includes(field)) throw new VoiceError(fill(data.words.unknown_field, { field, fields: FIELD_IDS.join(', ') }));
    const id = profileId(asked);
    const earlier = await readProfile(id);
    if (!earlier && (await idsOf(door, data.profile_type, { limit: data.max_profiles + 1 })).length > data.max_profiles) throw new VoiceError(fill(data.words.too_many_profiles, { max: String(data.max_profiles) }));
    if (expected !== undefined && (earlier?.set_at ?? null) !== expected) throw Object.assign(new VoiceError(fill(data.words.stale, { set_at: earlier?.set_at ?? 'never', expected })), { next_call: { tool: 'tool:read-voice', arguments: { kind: asked === data.any_kind ? undefined : asked } } });
    const kept = { ...(earlier?.fields ?? {}) };
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === '') delete kept[field];
      else kept[field] = text(value).slice(0, data.max_field_chars);
    }
    const profile = { profile_id: id, kind: asked, ...(name !== undefined ? { name: text(name).slice(0, 100) } : earlier?.name ? { name: earlier.name } : {}), fields: kept, set_at: now().toISOString(), set_by: by };
    await door.write([{ id, type: data.profile_type, value: profile }]);
    return { profile, said: `Saved the ${asked === data.any_kind ? 'general' : asked} voice profile.` };
  }

  /** Forgets a profile, one edit, or every edit (of one kind). */
  async function forget({ profile_id: profileKey, edit_id: editKey, all_edits: allEdits, kind } = {}) {
    const gone = [];
    if (profileKey) {
      if (!String(profileKey).startsWith(`${data.profile_type}:`) || !await readProfile(profileKey)) throw new VoiceError(`There is no voice profile ${profileKey}. tool:read-voice lists them.`);
      gone.push({ id: profileKey, type: data.profile_type, value: null });
    }
    if (editKey) {
      if (!String(editKey).startsWith(`${data.edit_type}:`) || !await readEdit(editKey)) throw new VoiceError(`There is no kept edit ${editKey}. tool:read-voice lists them.`);
      gone.push({ id: editKey, type: data.edit_type, value: null });
    }
    if (allEdits === true) {
      const asked = kind === undefined || kind === null || kind === '' ? undefined : kindOf(kind);
      for await (const { id, value } of door.list({ type: data.edit_type, fields: ['kind'] })) if (asked === undefined || value?.kind === asked) gone.push({ id, type: data.edit_type, value: null });
    }
    if (!gone.length) throw new VoiceError(data.words.nothing_named);
    for (let at = 0; at < gone.length; at += 100) await door.write(gone.slice(at, at + 100));
    return { forgot: gone.length, said: fill(data.words.forgot, { count: gone.length }) };
  }

  /** The word changes the person's kept edits repeat: each counted once per draft (subject_id, else the edit). */
  async function repeatedEdits({ kind, min_distinct_drafts: least = data.repeated.min_distinct_drafts } = {}) {
    if (!Number.isInteger(least) || least < 2) throw new VoiceError(data.words.repeat_minimum);
    const asked = kind === undefined || kind === null || kind === '' ? undefined : kindOf(kind);
    const edits = await editsOf(asked, data.keep_edits), seen = new Map();
    for (const edit of edits) for (const change of wordChanges(edit.before, edit.after)) {
      const key = `${change.from}\u0000${change.to}`, entry = seen.get(key) ?? seen.set(key, { ...change, drafts: new Set(), example: edit.edit_id }).get(key);
      entry.drafts.add(edit.subject_id ?? edit.edit_id);
    }
    const repeated = [...seen.values()].filter(entry => entry.drafts.size >= least)
      .map(({ from, to, drafts, example }) => ({ from, to, drafts: drafts.size, example_edit_id: example }))
      .sort((a, b) => b.drafts - a.drafts || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return { edits: edits.length, min_distinct_drafts: least, repeated, said: repeated.length ? data.words.repeated : data.words.none_repeated };
  }

  return { recordEdit, read, save, forget, repeatedEdits };
}

// One export per Workshop row, run as fn(input, { door }) by tools/records-door/do-work/run-an-export.mjs.
const voiceOf = context => makeVoice({ door: context.door });
export const readVoice = (input, context) => voiceOf(context).read(input);
export const saveVoice = ({ by, ...input } = {}, context) => voiceOf(context).save(input, by === 'person' ? 'person' : 'ai');
export const forgetVoice = (input, context) => voiceOf(context).forget(input);
export const keepAVoiceEdit = async (input, context) => ({ edit: await voiceOf(context).recordEdit(input ?? {}) });
export const findRepeatedVoiceEdits = (input, context) => voiceOf(context).repeatedEdits(input);
