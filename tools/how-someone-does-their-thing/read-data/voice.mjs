// src/voice.mjs
//
// Purpose
//   The person's writing voice, learned from what they change. Every time they change words an AI wrote (a draft's
//   caption), the before and the after are kept as an edit; an AI that learns something from those edits and from what
//   the person sent saves it as a profile; every AI that drafts for them reads the profiles, the edits and what was
//   sent before it writes. Nothing here decides what a good voice is: the edits are the person's own, the profile is the
//   AI's reading of them, and both can be read, replaced and forgotten.
//
// Non-negotiable invariants
//   1. The record types, the sizes and the profile's fields are DATA (src/voice.json). A field a profile may hold is a
//      row there; a field not named is refused in words, never kept.
//   2. An edit is kept only when the words really changed and the person changed them (the caller says so); the before
//      and after are the words themselves, cut to `max_edit_chars`, never a summary.
//   3. A profile is one record per kind of writing (`kind`, or `any_kind`); saving it again replaces it, and a save that
//      names `expected_set_at` is refused when the profile was saved since that read.
//   4. Only the newest `keep_edits` edits are kept; older ones are retired a few at a time, never by reading them all.
//   5. Nothing is sent anywhere and nothing is kept outside the person's own records. forget removes a profile, one edit
//      or every edit (of one kind), and says how many.
//
import data from './voice.json' with { type: 'json' };

export class VoiceError extends Error {}

const text = value => typeof value === 'string' ? value : '';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const KIND = new RegExp(data.kind_pattern);
const FIELD_IDS = data.profile_fields.map(field => field.id);

/**
 * eeaf:  the person's record store (read, write, ids).
 * now:   () → Date.
 * newId: () → unique text.
 * sent:  ({ kind, limit }) → [{ text, at, id }] of words the person sent, from whoever owns what was sent.
 */
export function makeVoice({ eeaf, now = () => new Date(), newId = () => crypto.randomUUID(), sent = () => [] }) {
  const kindOf = kind => {
    if (kind === undefined || kind === null || kind === '') return data.any_kind;
    if (typeof kind !== 'string' || !KIND.test(kind)) throw new VoiceError(data.words.bad_kind);
    return kind;
  };
  const profileId = kind => `${data.profile_type}:${kind}`;
  // A kind's profile is read by its id; all of them are one page of at most `max_profiles`, a number save() holds the account to.
  const profilesOf = kind => (kind !== undefined ? [eeaf.read(profileId(kind))] : eeaf.ids(data.profile_type, { limit: data.max_profiles }).map(id => eeaf.read(id))).filter(Boolean);

  /** Keeps what the person changed. Returns the edit kept, or null when nothing really changed. */
  function recordEdit({ kind, subject_id = null, before, after, before_by = null }) {
    const was = text(before).trim(), is = text(after).trim();
    if (!is || was === is) return null;
    const at = now().toISOString();
    const edit = {
      edit_id: `${data.edit_type}:${at}:${newId().replace(/-/g, '').slice(0, 10)}`, kind: kindOf(kind), subject_id, at,
      before: was.slice(0, data.max_edit_chars), after: is.slice(0, data.max_edit_chars), ...(before_by ? { before_by } : {}),
    };
    eeaf.write([{ id: edit.edit_id, type: data.edit_type, value: edit }], { actor: { by: 'person' } });
    const old = eeaf.ids(data.edit_type, { limit: data.keep_edits + 20 }).slice(data.keep_edits);
    if (old.length) eeaf.write(old.map(id => ({ id, type: data.edit_type, value: null })), { actor: { by: 'trillion' } });
    return edit;
  }

  /** Everything an AI reads before writing for this person. */
  function read({ kind, limit } = {}) {
    const asked = kind === undefined || kind === null || kind === '' ? undefined : kindOf(kind);
    const profiles = profilesOf(asked).map(profile => ({ profile_id: profile.profile_id, kind: profile.kind, name: profile.name ?? null, fields: profile.fields, set_at: profile.set_at, set_by: profile.set_by }));
    const edits = eeaf.ids(data.edit_type, { limit: Math.min(Math.max(Math.floor(Number(limit) || data.read.edits), 1), 50) })
      .map(id => eeaf.read(id)).filter(edit => edit && (asked === undefined || edit.kind === asked));
    const words = sent({ kind: asked, limit: data.read.sent }).map(row => ({ ...row, text: text(row.text).slice(0, data.read.sent_chars) }));
    return {
      how_to_use: data.words.how_to_use, fields: data.profile_fields, profiles, ...(profiles.length ? {} : { said: data.words.no_profile }),
      edits: edits.map(({ edit_id, kind: editKind, before, after, at, before_by }) => ({ edit_id, kind: editKind, before, after, at, ...(before_by ? { before_by } : {}) })), sent: words,
    };
  }

  /** Saves what an AI learned: one profile per kind. fields holds only the fields src/voice.json names. */
  function save({ kind, name, fields, expected_set_at: expected } = {}, by = 'ai') {
    const asked = kindOf(kind);
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) throw new VoiceError(fill(data.words.unknown_field, { field: 'fields', fields: FIELD_IDS.join(', ') }));
    for (const field of Object.keys(fields)) if (!FIELD_IDS.includes(field)) throw new VoiceError(fill(data.words.unknown_field, { field, fields: FIELD_IDS.join(', ') }));
    const id = profileId(asked);
    const earlier = eeaf.read(id);
    if (!earlier && eeaf.ids(data.profile_type, { limit: data.max_profiles + 1 }).length > data.max_profiles) throw new VoiceError(fill(data.words.too_many_profiles, { max: String(data.max_profiles) }));
    if (expected !== undefined && (earlier?.set_at ?? null) !== expected) throw Object.assign(new VoiceError(fill(data.words.stale, { set_at: earlier?.set_at ?? 'never', expected })), { next_call: { tool: 'read_voice', arguments: { kind: asked === data.any_kind ? undefined : asked } } });
    const kept = { ...(earlier?.fields ?? {}) };
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === '') delete kept[field];
      else kept[field] = text(value).slice(0, data.max_field_chars);
    }
    const profile = { profile_id: id, kind: asked, ...(name !== undefined ? { name: text(name).slice(0, 100) } : earlier?.name ? { name: earlier.name } : {}), fields: kept, set_at: now().toISOString(), set_by: by };
    eeaf.write([{ id, type: data.profile_type, value: profile }], { actor: { by } });
    return { profile, said: `Saved the ${asked === data.any_kind ? 'general' : asked} voice profile.` };
  }

  /** Forgets a profile, one edit, or every edit (of one kind). */
  function forget({ profile_id: profileKey, edit_id: editKey, all_edits: allEdits, kind } = {}) {
    const gone = [];
    if (profileKey) {
      if (!String(profileKey).startsWith(`${data.profile_type}:`) || !eeaf.read(profileKey)) throw new VoiceError(`There is no voice profile ${profileKey}. read_voice lists them.`);
      gone.push({ id: profileKey, type: data.profile_type, value: null });
    }
    if (editKey) {
      if (!String(editKey).startsWith(`${data.edit_type}:`) || !eeaf.read(editKey)) throw new VoiceError(`There is no kept edit ${editKey}. read_voice lists them.`);
      gone.push({ id: editKey, type: data.edit_type, value: null });
    }
    if (allEdits === true) {
      const asked = kind === undefined || kind === null || kind === '' ? undefined : kindOf(kind);
      let before;
      for (;;) {
        const page = eeaf.ids(data.edit_type, { limit: 100, ...(before ? { before } : {}) });
        if (!page.length) break;
        for (const id of page) if (asked === undefined || eeaf.read(id)?.kind === asked) gone.push({ id, type: data.edit_type, value: null });
        before = page.at(-1);
      }
    }
    if (!gone.length) throw new VoiceError(data.words.nothing_named);
    eeaf.write(gone, { actor: { by: 'trillion' } });
    return { forgot: gone.length, said: fill(data.words.forgot, { count: gone.length }) };
  }

  return { recordEdit, read, save, forget };
}
