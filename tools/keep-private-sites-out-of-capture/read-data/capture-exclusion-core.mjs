// tools/keep-private-sites-out-of-capture/read-data/capture-exclusion.mjs (moved from Trillion computer/capture-exclusion.mjs)
//
// Purpose
//   Privacy categories for what the Mac reader may read, as data: a seed of domains by category, the person's on/off choice
//   per category, and a cursor diff with tombstones so coverage grows without an app release. `domainsOf` gives the
//   excluded domains for the capture session's exclusion list; `excluded` answers for one address.
//
// Non-negotiable invariants
//   1. Categories, defaults, the seed and words are DATA (capture-exclusion.json); the person's choices (`prefs`) and the
//      diff state (`state`) are the caller's: they come in with the input and the changed one goes back out. Nothing is written here.
//   2. A diff is applied only if it starts at this Mac's cursor (no gap, no replay); a removal (tombstone) outlives a seed
//      reload: a removed domain is never listed again by the seed.
//   3. Subdomains belong to their domain's category; a look-alike (`evilbank.example` for `bank.example`) does not.
//   4. A category the person has not turned on excludes nothing; their choice beats the default.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/keep-private-sites-out-of-capture/read-data/capture-exclusion.mjs exclusion
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const exclusionSettings = () => JSON.parse(readFileSync(path.join(HERE, 'capture-exclusion.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** The state: seed domains by category, added later by diffs, and removed (tombstones), with the cursor. */
export function loadState(settings, given = null) {
  return given ?? { cursor: settings.cursor, added: {}, removed: [] };
}
const normal = domain => String(domain).toLowerCase().replace(/^\.+|\.+$/g, '');

/** Every domain of one category now: seed plus added, minus tombstones. */
export function domainsIn(settings, state, category) {
  const gone = new Set(state.removed.map(normal));
  return [...new Set([...(settings.seed[category] ?? []), ...(state.added[category] ?? [])].map(normal))].filter(domain => !gone.has(domain));
}

/** The categories on: the person's choice (`prefs`: { id: boolean }) over the DATA default. */
export const categoriesOn = (settings, prefs = {}) => settings.categories.filter(row => (Object.hasOwn(prefs, row.id) ? prefs[row.id] === true : row.default)).map(row => row.id);

/** The excluded domains for the capture session's list. */
export const domainsOf = (settings, state, prefs) => categoriesOn(settings, prefs).flatMap(category => domainsIn(settings, state, category));

/** Which category an address is in (among the ones on), or null. */
export function excluded(settings, state, prefs, address) {
  let host;
  try { host = normal(new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`).hostname); } catch { return null; }
  for (const category of categoriesOn(settings, prefs)) {
    if (domainsIn(settings, state, category).some(domain => host === domain || host.endsWith(`.${domain}`))) return category;
  }
  return null;
}

/** State after a cursor diff { from, to, add: [{ domain, category }], remove: [domain] }; throws when it does not start at the cursor. */
export function applyDiff(settings, state, diff) {
  if (diff.from !== state.cursor) throw fail(fill(settings.words.stale_diff, { from: diff.from, cursor: state.cursor }), 409);
  const added = Object.fromEntries(Object.entries(state.added).map(([category, list]) => [category, [...list]]));
  for (const row of diff.add ?? []) {
    if (!settings.categories.some(category => category.id === row.category)) throw fail(fill(settings.words.no_category, { category: row.category }));
    added[row.category] = [...new Set([...(added[row.category] ?? []), normal(row.domain)])];
  }
  const removed = [...new Set([...state.removed, ...(diff.remove ?? []).map(normal)])];
  const readded = new Set((diff.add ?? []).map(row => normal(row.domain)));
  return { cursor: diff.to, added, removed: removed.filter(domain => !readded.has(domain)) };
}

export const exclusionTools = {
  /** { action: list | check | set | diff, address?, category?, on?, diff?, prefs?, state? }; `set` answers the new `prefs`, `diff` the new `state`. */
  async exclusion(input) {
    const settings = exclusionSettings();
    const prefs = input.prefs ?? {}; const state = loadState(settings, input.state ?? null);
    switch (input.action ?? 'list') {
      case 'check': return { category: excluded(settings, state, prefs, String(input.address ?? '')) };
      case 'set': {
        if (!settings.categories.some(row => row.id === input.category)) throw fail(fill(settings.words.no_category, { category: input.category }));
        const next = { ...prefs, [input.category]: input.on === true };
        return { on: categoriesOn(settings, next), prefs: next };
      }
      case 'diff': { const next = applyDiff(settings, state, input.diff); return { cursor: next.cursor, state: next }; }
      default: return { categories: settings.categories.map(row => ({ id: row.id, label: row.label, on: categoriesOn(settings, prefs).includes(row.id), domains: domainsIn(settings, state, row.id).length })), cursor: state.cursor };
    }
  },
};

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { exclusion } = exclusionTools;
