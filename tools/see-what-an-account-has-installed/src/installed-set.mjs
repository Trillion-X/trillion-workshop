// src/installed-set.mjs
//
// PURPOSE
//   Which of Trillion's own tools, workflows, rules and event rules an account has, worked out from the account's
//   Marketplace install rows (`marketplace-install:private:<id>`) and the shipped catalog (src/starting-catalog.mjs).
//   An installed configuration brings its components; a row's `without` names components the person removed from it. This
//   module is pure: it is handed the rows and the catalog index and reads nothing itself, apart from the small reader
//   in `installedSetReader`, which is handed the function that reads the rows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An id the catalog does not name is never removed: `has` says yes to it. Only a catalog id that is neither core
//      nor in an installed configuration (and not removed from it) is out.
//   2. Compatibility: until the account's starting set has been installed (`started`), and whenever the rows could not be
//      read, the set is `all` and every `has` says yes. A failed read is never remembered.
//   3. Core ids are always in. Pinned ids (called by name in code until the job slots land) can never be removed.
//   4. A component cannot be removed while another component that is in uses it (`dependents`), so removing one never
//      leaves a workflow or rule calling something that is gone.
//   5. One scan of the install rows serves every reader until `invalidate` (an install or uninstall) says it moved.
//

import { currentInstallRow } from '../../shared-code/src/renamed-tools.mjs';
import { configurationIdentity } from './marketplace-configurations.mjs';

const isStartingRow = (row, manifest) => Boolean(row && row.context === 'private'
  && ((typeof row.follows === 'string' && manifest.configurationBySlug(row.follows)) || manifest.configuration(row.configuration_id)));

// The configuration a row stands for: the one it follows by name (so a new version of it is the same switch), else its own.
const configurationOfRow = (row, manifest) => (typeof row.follows === 'string' && manifest.configurationBySlug(row.follows)) || manifest.configuration(row.configuration_id);

// The synchronous legacy reader and the bounded native fold use one union /
// subtraction rule. Only canonical configuration membership is accumulated.
function foldRows(installRows, manifest, held = {}) {
  const installed = new Set(held.installed);
  const without = new Set(held.without);
  const configurations = new Set(held.configurations);
  for (const row of installRows.map(currentInstallRow).filter(row => isStartingRow(row, manifest))) {
    const configuration = configurationOfRow(row, manifest);
    configurations.add(configuration.slug);
    const removed = new Set(Array.isArray(row.without) ? row.without : []);
    for (const id of manifest.members(configuration.id)) (removed.has(id) ? without : installed).add(id);
  }
  // A later page may bring a component removed by an earlier configuration.
  // An earlier bring also wins over a later removal from another configuration.
  for (const id of installed) without.delete(id);
  return { installed, without, configurations };
}
const setFrom = ({ installed, without, configurations }, manifest, all) => Object.freeze({
  all, installed, without, configurations, pinned: manifest.pinned,
  has: id => all || manifest.core.has(id) || !manifest.ids.has(id) || installed.has(id),
});

/**
 * installRows: the account's install rows (installedConfiguration shape), or null/undefined when they could not be read
 * manifest:    the catalog index (startingManifest())
 * started:     true once this account's starting set was installed (the account fact); false/unknown keeps everything in
 * → { all, has(id), installed: Set (ids brought by an installed configuration, removals left out), without: Set,
 *     pinned: Set, configurations: Set (slugs installed) }
 */
export function installedSet(installRows, manifest, { started = false } = {}) {
  const folded = foldRows(Array.isArray(installRows) ? installRows : [], manifest);
  const all = !Array.isArray(installRows) || (!started && !folded.configurations.size);
  return setFrom(folded, manifest, all);
}

const FOLD = 'installed-set-fold';
const PAGE_ROWS = 64;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const cursor = value => value === null || text(value);
const pending = reason => Object.assign(new Error('The complete current installation set is still being prepared.'),
  { status: 503, code: 'installed_set_preparing', installed_set_pending: true, preparing: true, reason });
const changed = reason => Object.assign(new Error('The installation proof changed. Restart from its original first page.'),
  { status: 409, code: 'installed_set_changed', installed_set_changed: true, restart: true, reason });
const refused = reason => Object.assign(new Error('This is not an original complete installation proof.'),
  { status: 409, code: 'installed_set_refused', reason });
const sourceOf = source => {
  if (!object(source) || !text(source.owner) || !text(source.resource)
    || !Number.isSafeInteger(source.generation) || source.generation < 1 || !text(source.revision)
    || source.principal !== undefined && !text(source.principal)
    || Object.keys(source).some(key => !['owner', 'resource', 'generation', 'revision', 'principal'].includes(key)))
    throw pending('source_unavailable');
  return { owner: source.owner, resource: source.resource, generation: source.generation, revision: source.revision,
    ...(source.principal === undefined ? {} : { principal: source.principal }) };
};
const manifestIdentity = manifest => {
  if (!text(manifest?.identity)) throw pending('catalogue_unavailable');
  return manifest.identity;
};
const same = (left, right) => configurationIdentity(left) === configurationIdentity(right);

function assertFold(state, manifest, source) {
  if (!object(state) || state.kind !== FOLD || !['collecting', 'exhausted'].includes(state.phase)
    || !cursor(state.next) || !Number.isSafeInteger(state.pages) || state.pages < 0
    || !Number.isSafeInteger(state.after_seq) || state.after_seq < 0 || typeof state.started !== 'boolean') throw refused('invalid_accumulator');
  if (state.manifest_identity !== manifestIdentity(manifest)) throw changed('catalogue_changed');
  if (!same(sourceOf(state.source), sourceOf(source))) throw changed('source_changed');
  if (state.phase === 'exhausted' && (state.pages === 0 || state.next !== null)
    || state.phase === 'collecting' && (state.pages === 0 ? state.next !== null : state.next === null)) throw refused('invalid_progression');
  const members = new Set(manifest.configurations.flatMap(row => manifest.members(row.id)));
  for (const key of ['installed', 'without']) {
    if (!Array.isArray(state[key]) || new Set(state[key]).size !== state[key].length || state[key].some(id => !members.has(id))) throw refused('invalid_membership');
  }
  if (state.installed.some(id => state.without.includes(id)) || !Array.isArray(state.configurations)
    || new Set(state.configurations).size !== state.configurations.length
    || state.configurations.some(slug => !manifest.configurationBySlug(slug))) throw refused('invalid_membership');
  if (state.target_ref !== null && (!object(state.target_ref) || !text(state.target_ref.entity)
    || !state.target_ref.entity.startsWith('marketplace-install:') || !text(state.target_ref.id))) throw refused('invalid_target');
  if (state.target !== null && (!state.target_ref || state.target.entity !== state.target_ref.entity
    || state.target.id !== state.target_ref.id || !Number.isSafeInteger(state.target.seq)
    || state.target.seq < 1 || state.target.seq > state.after_seq || !text(state.target.identity)
    || !text(state.target.current_identity) || !text(state.target.without_identity)
    || !text(state.target.configuration_id) || !text(state.target.context)
    || state.target.follows !== null && typeof state.target.follows !== 'string'
    || typeof state.target.removed !== 'boolean')) throw refused('invalid_target');
}

/**
 * Trusted native preparation DATA, never a public authorization token. The
 * original command owner persists this accumulator between admitted pages.
 * `source` is the actual owner/resource/generation/semantic revision (and an
 * optional principal identity), not values supplied by the customer. `target`
 * selects one original Workshop entity and installation id for an eventual
 * removal. No private installation body is retained in this state.
 */
export function beginInstalledSet(manifest, { source, started = false, target = null } = {}) {
  if (typeof started !== 'boolean' || target !== null && (!object(target) || !text(target.entity)
    || !target.entity.startsWith('marketplace-install:') || !text(target.id))) throw refused('invalid_preparation');
  return {
    kind: FOLD, phase: 'collecting', manifest_identity: manifestIdentity(manifest), source: sourceOf(source),
    started, next: null, pages: 0, after_seq: 0, installed: [], without: [], configurations: [],
    target_ref: target === null ? null : { entity: target.entity, id: target.id }, target: null,
  };
}

/**
 * Fold exactly one admitted, unfiltered Workshop sequence page. `cursor` is
 * the native request's original opaque continuation (null for the first page);
 * `next` is its actual next opaque continuation or null on source exhaustion.
 * Rows are the source's {entity,seq,value}, including removed/irrelevant rows.
 * A customer's `complete` flag cannot finish this fold. The native host owns
 * admission, page provenance, and the final current fence before any effect.
 */
export function foldInstalledSet(state, page, manifest) {
  if (!object(page) || !Array.isArray(page.rows) || page.read_failed === true
    || page.pending === true || page.preparing === true || page.error != null) throw pending('read_failed');
  assertFold(state, manifest, page.source);
  if (state.phase !== 'collecting') throw refused('already_exhausted');
  if (!cursor(page.cursor) || page.cursor !== state.next) throw changed('cursor_changed');
  if (!Object.hasOwn(page, 'next') || !cursor(page.next) || page.next !== null && page.next === page.cursor
    || page.rows.length > PAGE_ROWS) throw refused('invalid_page');
  let after_seq = state.after_seq, target = state.target;
  const live = [];
  for (const row of page.rows) {
    if (!object(row) || !text(row.entity) || !row.entity.startsWith('marketplace-install:')
      || !Number.isSafeInteger(row.seq) || row.seq <= after_seq) throw refused('invalid_positions');
    after_seq = row.seq;
    if (state.target_ref?.entity === row.entity) {
      if (target || !object(row.value) || row.value.id !== state.target_ref.id) throw changed('target_changed');
      const current = currentInstallRow(row.value);
      if (!text(row.value.configuration_id) || !text(row.value.context)
        || current.follows !== undefined && current.follows !== null && typeof current.follows !== 'string') throw refused('invalid_target');
      target = {
        entity: row.entity, seq: row.seq, id: row.value.id, configuration_id: row.value.configuration_id ?? null,
        context: row.value.context ?? null, follows: current.follows ?? null, removed: Boolean(row.value.removed_at),
        identity: configurationIdentity(row.value), current_identity: configurationIdentity(current),
        without_identity: configurationIdentity(current.without ?? []),
      };
    }
    if (object(row.value) && !row.value.removed_at) live.push(row.value);
  }
  // This input is the raw sequence page; an empty nonterminal page would lack
  // the original position needed to prove any forward progress.
  if (page.next !== null && after_seq === state.after_seq) throw refused('nonadvancing_page');
  const folded = foldRows(live, manifest, state);
  return {
    kind: FOLD, manifest_identity: state.manifest_identity, started: state.started,
    source: sourceOf(page.source), phase: page.next === null ? 'exhausted' : 'collecting',
    next: page.next, pages: state.pages + 1, after_seq, target,
    target_ref: state.target_ref === null ? null : { entity: state.target_ref.entity, id: state.target_ref.id },
    installed: [...folded.installed], without: [...folded.without], configurations: [...folded.configurations],
  };
}

/**
 * Only actual source exhaustion yields a set. The supplied current source and
 * exact full manifest must still match. The host rechecks those and the target
 * identity synchronously inside the final mutation, after every awaited gate.
 * Legacy fail-open behavior remains confined to installedSet/its old reader.
 */
export function finishInstalledSet(state, manifest, { source } = {}) {
  assertFold(state, manifest, source);
  if (state.phase !== 'exhausted') throw pending('incomplete');
  if (!state.started && !state.configurations.length) throw pending('starting_set_unproven');
  if (state.target_ref && !state.target) throw refused('target_unavailable');
  const set = setFrom({ installed: new Set(state.installed), without: new Set(state.without),
    configurations: new Set(state.configurations) }, manifest, false);
  return Object.freeze({ ...set, source: Object.freeze(sourceOf(state.source)), manifest_identity: state.manifest_identity,
    target: state.target === null ? null : Object.freeze({ ...state.target }) });
}

/** The components of `kind` in `catalog` (any list of { kind, id }) that the set has, in the catalog's order. */
export const installedRows = (kind, set, catalog) => catalog.filter(item => item.kind === kind && set.has(item.id));

/** `rows` (each with an id) without the ones the catalog names that the set does not have. */
export const filterToInstalled = (rows, set, idOf = row => row.id) => set.all ? rows : rows.filter(row => set.has(idOf(row)));

/** The components that are in the set and use `id`, so removing `id` would leave them calling something that is gone. */
export function dependents(id, set, manifest) {
  return [...manifest.ids].filter(other => other !== id && set.has(other) && manifest.component(other).uses?.includes(id)).sort();
}

/**
 * Why `id` cannot be removed from the account, or null when it can: { pinned: true } when code calls it by name,
 * { core: true } when it is always on, { blocked_by: [ids] } when something that is in uses it.
 */
export function removalBlocked(id, set, manifest) {
  if (manifest.core.has(id)) return { core: true };
  if (set.pinned.has(id)) return { pinned: true };
  const blocked_by = dependents(id, set, manifest);
  return blocked_by.length ? { blocked_by } : null;
}

/**
 * readRows: async () → the install rows (a prefix scan of `marketplace-install:`); started: async () → true once the
 * starting set was installed. → { current(), invalidate() }; current() reads once and then answers from memory.
 * A read that throws answers the whole set (invariant 2) and is asked again next time.
 */
export function installedSetReader({ readRows, manifest, started = async () => false }) {
  let held = null;
  return {
    current() {
      held ??= (async () => installedSet(await readRows(), await manifest(), { started: await started() }))()
        .catch(async () => { held = null; return installedSet(null, await manifest()); });
      return held;
    },
    invalidate() { held = null; },
  };
}
