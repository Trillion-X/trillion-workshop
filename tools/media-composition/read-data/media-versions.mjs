// parts/media-composition/read-data/media-versions.mjs
//
// EDITS ARE VERSIONS BESIDE AN UNTOUCHED ORIGINAL; THE PERSON CHOOSES WHICH ONE IS SEEN BY DEFAULT.
//
// Purpose: an edit never overwrites the recording it came from. Each publish adds a version rendered from the original, with its
// own title and summary; the person publishes it "and make it the default" (a link that used to show the original now shows it) or
// "watch only" (a link to that version only). Old versions stay until removed, the original always stays, and a publish that
// cannot succeed (a render or another publish running, one a moment ago, or an edit too short) is refused with plain words before
// any work starts.
//
// Non-negotiable invariants:
//   1. Pure: every function takes the recording's versions state and returns the next state or an answer; nothing is stored here.
//   2. The original is version `original`, listed first, cannot be removed and is what a link shows until a default is set.
//   3. A version that is the default cannot be removed until another default is chosen.
//   4. Refusals are machine codes with words from DATA (./media-versions.json); the limits are DATA too.
//
// State: { versions: [{ id, label, title?, summary?, published_at }], default_id: string | null, last_published_at: string | null,
//          renders_running: number, publishing: boolean }
import rules from './media-versions.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const refusal = (code, values, settings) => ({ ok: false, code, message: fill(settings.words[code], values) });

/** A new recording's state: the original only, shown by default. */
export const newVersionsState = (settings = rules) => ({
  versions: [{ id: settings.original.id, label: settings.original.label, published_at: null }],
  default_id: null, last_published_at: null, renders_running: 0, publishing: false,
});

/** Whether an edit of `seconds` may be published at `now` (ISO). -> { ok } or { ok: false, code, message } */
export function canPublish(state, { seconds, now }, settings = rules) {
  if (state.renders_running > 0) return refusal('RENDERING', {}, settings);
  if (state.publishing) return refusal('PUBLISHING', {}, settings);
  if (state.last_published_at) {
    const wait = Math.ceil(settings.min_gap_seconds - (Date.parse(now) - Date.parse(state.last_published_at)) / 1000);
    if (wait > 0) return refusal('TOO_SOON', { wait_seconds: wait }, settings);
  }
  if (seconds < settings.min_seconds) return refusal('TOO_SHORT', { min_seconds: settings.min_seconds }, settings);
  return { ok: true };
}

/**
 * Publishes a rendered edit as a new version: `{ id, label, title?, summary?, seconds, now, make_default }`.
 * -> { ok, state } or { ok: false, code, message }. `make_default` is "watch and set as default"; without it, "watch only".
 */
export function publishVersion(state, version, settings = rules) {
  const allowed = canPublish(state, { seconds: version.seconds, now: version.now }, settings);
  if (!allowed.ok) return allowed;
  if (state.versions.some((found) => found.id === version.id)) return refusal('DUPLICATE', { id: version.id }, settings);
  const { id, label, title, summary, now } = version;
  return {
    ok: true,
    state: {
      ...state,
      versions: [...state.versions, { id, label, ...(title ? { title } : {}), ...(summary ? { summary } : {}), published_at: now }],
      default_id: version.make_default ? id : state.default_id,
      last_published_at: now,
    },
  };
}

/** Makes `id` the version a link shows by default (the original again when `id` is the original's id). */
export function setDefaultVersion(state, id, settings = rules) {
  if (!state.versions.some((found) => found.id === id)) return refusal('NOT_FOUND', { id }, settings);
  return { ok: true, state: { ...state, default_id: id === settings.original.id ? null : id } };
}

/** Removes an old version. The original and the default stay. */
export function removeVersion(state, id, settings = rules) {
  if (id === settings.original.id) return refusal('ORIGINAL', {}, settings);
  if (!state.versions.some((found) => found.id === id)) return refusal('NOT_FOUND', { id }, settings);
  if (state.default_id === id) return refusal('DEFAULT', {}, settings);
  return { ok: true, state: { ...state, versions: state.versions.filter((found) => found.id !== id) } };
}

/** The version a link serves: the one asked for if it exists, else the default, else the original. Never null. */
export function versionServed(state, askedId, settings = rules) {
  const found = (id) => state.versions.find((version) => version.id === id);
  return found(askedId) ?? found(state.default_id) ?? found(settings.original.id);
}
