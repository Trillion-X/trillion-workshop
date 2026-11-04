// src/layouts.mjs
//
// Purpose
//   Screen layouts any of the person's AIs makes, or the one on screen rearranged, as DATA: the same short shape
//   Trillion's starter layouts are (parts/screen-arrangement/read-data/starter-layouts.ts: panes of screens, split
//   side by side or stacked). They sit in the person's Layouts menu beside the starters, and one can ask to be opened
//   at once on the person's open page.
//
//   GET  /layouts        { screens, opens_one_thing, layouts, categories, recent, current, current_shown_at, said }
//   POST /layouts/save   { layout, category?, open_now?, by?, expected_identity? }   { layout, said }
//   POST /layouts/save   { screen, layout: { arrangement } | null, expected_identity? }  { screen, arranged, said }
//   POST /layouts/remove { layout_id, expected_identity?, detach_users? }  { removed, detached, said }
//   POST /layouts/open   { layout_id }                { opened, said }
//   POST /layouts/sync   { part, layouts?, screens?, version? }   { synced, refused, said }
//   POST /layouts/history { layout_id | screen, kind?, before? }  { owner_type, versions, next_cursor, said }
//   POST /layouts/keep    { layout_id | screen, kind? }            { kept, said }
//   POST /layouts/restore { layout_id | screen, revision_id, expected_identity? }  { layout | screen, warnings, said }
//
// Non-negotiable invariants
//   1. A layout is read by the arrangement's own decoder (readStarterLayouts); one it refuses is refused here, and every
//      screen it names must be one this person is offered. The page builds the arrangement from it (starterLayoutState).
//   2. Opening goes through the arrangement's one switch on the page (use-layout-choices open), which keeps the layout
//      it replaces as Previous layout first; nothing here writes the arrangement itself.
//   3. `current` is the arrangement on screen as the same short shape, as the page last published it
//      (parts/screen-arrangement/show/publish-shown-arrangement.tsx, starterArrangementOf), with when it was shown, so
//      an AI rearranges it by changing that DATA. null until a page has shown one.
//   4. A pane may hold one thing (one list, one decision): { id, input, title? } names a screen that opens one thing
//      (its catalog row has route_input) and the input it opens on. `opens_one_thing` lists those screens and the input
//      key each takes, read from the catalog, so the AI that made a list can open that list, not only Lists.
//      Any screen the person has may carry an input holding only `kept` (what that placement keeps: its rules, grouping,
//      view and depth, parts/ui/show/placement-kept), so an AI places a list already drilled to where it is wanted, and
//      the inputs its address's query opens it with (its catalog row's route_query: Record video on a run of takes) and, for a guide
//      screen, what narrows it (surfaces.json `narrowing`: Connections on `show_row`), so a pane opens on what that
//      screen's own address opens.
//   5. Any screen is arranged the same way: `screen` names a screen and the arrangement becomes that screen's own
//      (kept at src/workspace/screen-own-arrangement.json `kept_prefix` + the screen, built by the arrangement's own
//      starterLayoutState from the same offered rows the page reads), so the screen redraws as it on every open page;
//      a null layout puts the screen back as it started. `arranged` in the read is every screen arranged so, in the
//      same short shape.
//
//   6. One layout per held thing: a layout may carry `held`, the key of the thing it was made to show (take-me-there passes
//      the Waiting on you thing key), and saving again for the same key replaces every copy of it in the same write.
//      `replaces` names (as take-me-there named it) the layouts earlier copies were kept as before they carried the key. The cap counts what is left after that,
//      and a layout kept under one id more than once is read, and written, as the newest copy alone.
//   7. A save is refused when it was made from an older copy: every layout and every screen's own arrangement is read
//      with `identity` (the BLAKE3 content identity of what is kept, src/workspace/conflicts.mjs) and a layout with its
//      `edit` count (its edit epoch, one more on every save). A save or remove naming `expected_identity` (null: "there
//      is none yet") writes only while that is still what is kept, checked inside the same commit as the write, and is
//      otherwise refused (409, refused.code `stale`) with the identity kept now, so the writer reads again. A save
//      without it stays a plain write.
//   8. A layout is a shared part of other layouts and screens (src/layout-parts.mjs): an arrangement may hold
//      { kind: 'part', layout, version?, overrides? }. What is kept is the arrangement as written (`written`, with the
//      parts it `uses`) beside its expansion (`arrangement`, what the page draws). A use without a version follows the
//      part: saving the part expands it again in the same write. A pinned use stays at its version, and read lists it
//      under `updates_available` with every layout and screen pinned behind; `sync` re-pins them. A layout or screen
//      rearranged by hand since it was expanded (its arrangement is not the one expanded) is never expanded over.
//      Removing a part others use is refused unless `detach_users` writes its arrangement into each of them.
//   9. Versions are the one version store's (src/native-workspace-records.mjs, owner types `layout` and
//      `screen-arrangement`): `history` reads them, `keep` keeps one on request, and `restore` puts one back as the
//      kept layout (opening it is a separate step), warning of every screen and part it names that is gone. A restored
//      layout is kept exactly as that version was, its expansion and pins included.
//

import settings from './layouts.json' with { type: 'json' };
import surfaces from '../../shared-code/src/workspace/screens.mjs';
import arranging from './workspace/screen-own-arrangement.json' with { type: 'json' };
import { readStarterLayouts, starterArrangementOf, starterLayoutState, starterSurfaceId } from '../../arrange-screens-in-panes/read-data/starter-layouts.ts';
import { readPlaceableSurfaces } from '../parts/ui/show/placeable-surface-intent/placeable-surface-record.ts';
import { LAYOUT_LIBRARY } from '../../arrange-screens-in-panes/read-data/layout-library.ts';
import { GROUP_RECORD, keptLibrary } from './kept-libraries.mjs';
import { failureOf } from '../../shared-code/src/failure.mjs';
import { workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';
import historyRules from './workspace-record-history.json' with { type: 'json' };
import { revisionPolicyFor } from './workspace-revision-selection.mjs';
import { expandParts, inlinePart, partsUsedBy, pinPart, writtenWithParts } from './layout-parts.mjs';

const library = keptLibrary(LAYOUT_LIBRARY);

const shapeError = 'arrangement is a pane { kind: "pane", surfaces: [screen ids], show? } or a split { kind: "split", dir: "row" | "column", sizes? (relative, or each pane\'s pixels with unit: "px", where 0 is the height or width of what it shows; keep: true keeps those lengths exactly and the arrangement scrolls), across? (each pane\'s own height in a row or width in a stack, in pixels, null to fill), stack? (a row narrower than this many pixels shows as a stack), children: [...] }; read_layouts gives the screen ids and the arrangement on screen.';
const unknownError = unknown => `These are not screens this person has: ${unknown.join(', ')}. read_layouts lists the screens, and in opens_one_thing the screens that open one thing with the input each takes.`;

// When a layout was kept, as a sortable number (0 when unknown).
const stamp = layout => Date.parse(layout?.made_at ?? '') || 0;
// The layouts with one copy of each id: where the same id was kept more than once (take-me-there used to add a copy on
// every open), the newest stays, in the place it was.
const collapse = layouts => {
  const newest = new Map();
  for (const one of layouts) if (!newest.has(one.id) || stamp(one) > stamp(newest.get(one.id))) newest.set(one.id, one);
  return layouts.filter(one => newest.get(one.id) === one);
};

const text = value => (typeof value === 'string' ? value.trim() : '');
// The identity of what is kept (null when nothing is), the one a stale save is measured against (invariant 7).
const identityOf = value => (value === undefined || value === null ? null : workspaceValueIdentity(value));
// Refuses a save made from an older copy: `expected` is what the writer read (undefined: it named none).
const refuseStale = (expected, kept, what) => {
  if (expected === undefined) return;
  if (expected !== null && typeof expected !== 'string') throw new Error('expected_identity is the identity read_layouts gave, or null for one not kept yet.');
  const now = identityOf(kept);
  if (now === expected) return;
  throw Object.assign(new Error(`${what} changed since it was read (it is ${now ?? 'not kept'} now, not ${expected ?? 'not kept'}); read_layouts again and save from what is kept now.`),
    { status: 409, refused: { code: 'stale', expected_identity: expected, current_identity: now } });
};
// The member a screen's own arrangement is versioned as in the one version store (a whole-record owner type).
const SCREEN_MEMBER = revisionPolicyFor(arranging.kept_prefix, historyRules.records)?.collection?.whole;
const PARTS = settings.parts.screens_label;
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);


// The surface ids an arrangement node names, in order.
const surfacesIn = node => (node.kind === 'pane' ? node.surfaces : node.children.flatMap(surfacesIn));
// The screens a screen's own starting arrangement holds (Home's cards), read from its row's surface_input.arrangement, so
// rearranging that screen may keep them even when they are not listed on their own.
const ownPiecesOf = row => {
  const walk = node => (!node || typeof node !== 'object' ? [] : node.kind === 'pane'
    ? (Array.isArray(node.surfaces) ? node.surfaces : []).map(one => (typeof one === 'string' ? one : one?.id)).filter(Boolean)
    : (Array.isArray(node.children) ? node.children.flatMap(walk) : []));
  return walk(row?.surface_input?.arrangement);
};
// The screens that open one thing (a catalog row with route_input), each with the input key it takes.
const oneThingScreens = () => surfaces.surfaces.filter(row => typeof row.route_input === 'string');
// The inputs a screen opens with from its address's query (its catalog row's route_query), by screen.
const queryInputs = () => new Map(surfaces.surfaces.filter(row => row.route_query).map(row => [row.id, new Set(Object.values(row.route_query))]));

/**
 * records: { read() → { label: value }, write([{ address_label, payload }]) } (the person's workspace records)
 * rows:    async () → the screen rows this person is offered beyond the app's own (their tools' screens)
 * now:     () → Date
 * versions: { history(address, { scope_id, kind?, before?, limit? }), revision(id), keep({ address, scope_id, kind? }) }
 *          the one version store (src/native-workspace-records.mjs); without it pins resolve to the layout now.
 */
// The writes whose whole effect is one synchronous write, committed with their reply through `commit` (a write and its
// reply kept under the command's receipt, src/standalone-resource-behavior.mjs routeReceipts).
export const LAYOUT_RECEIPTED_WRITES = Object.freeze(['layouts:save', 'layouts:remove', 'layouts:open', 'layouts:sync', 'layouts:keep', 'layouts:restore']);
export function makeLayouts({ records, rows, now = () => new Date(), commit = change => change(), versions = null }) {
  const readRecords = () => records.read({ labels: [settings.layouts_label, settings.shown_label, PARTS], prefixes: [arranging.kept_prefix, GROUP_RECORD] });
  async function offered() {
    const extra = await rows().catch(() => []);
    return [...surfaces.surfaces.filter(row => row.listed !== false), ...extra];
  }
  const ownLayouts = current => collapse(Array.isArray(current[settings.layouts_label]) ? current[settings.layouts_label] : []);
  // Each screen arranged in place with parts: { [screen]: { written, uses, expanded } } (invariant 8).
  const screenParts = current => (current[PARTS] && typeof current[PARTS] === 'object' && !Array.isArray(current[PARTS]) ? current[PARTS] : {});

  // A layout's version is the number the one version store gave its newest kept version (it only grows, a put-back
  // included), null where versions are not kept. `cache` keeps one answer per layout for one read.
  async function versionNow(id, cache = null) {
    if (!versions) return null;
    if (cache?.has(id)) return cache.get(id);
    const number = (await versions.history(settings.layouts_label, { scope_id: id, limit: 1 })).revisions[0]?.number ?? null;
    cache?.set(id, number);
    return number;
  }
  // A layout as kept at version `number` (null when that version is no longer kept).
  async function layoutAtVersion(id, number) {
    if (!versions) return null;
    const [row] = (await versions.history(settings.layouts_label, { scope_id: id, before: number + 1, limit: 1 })).revisions;
    return row?.number === number ? (await versions.revision(row.id))?.value ?? null : null;
  }
  // How a part resolves among `layouts` (invariant 8): pinned to a kept version, else the layout as it is now.
  const resolverOver = layouts => async ({ layout, version }) => {
    const live = layouts.find(one => one.id === layout);
    if (!live) return null;
    const now = { arrangement: live.written ?? live.arrangement };
    if (version === null) return now;
    const then = await layoutAtVersion(layout, version);
    return then ? { arrangement: then.written ?? then.arrangement } : { ...now, fell_back: true };
  };
  // A written arrangement made ready to keep: its expansion decoded as the page decodes it, and the parts it uses.
  async function expandWritten(written, layouts, trail) {
    if (!writtenWithParts(written)) return { arrangement: written, used: null };
    const { arrangement, used } = await expandParts(written, resolverOver(layouts), trail);
    return { arrangement, used };
  }
  // Every layout and screen whose written arrangement uses `part` (any part when null), with how to keep it again.
  function usersOf(current, layouts, part = null) {
    const uses = written => partsUsedBy(written).some(use => part === null || use.layout === part);
    return [
      ...layouts.filter(one => one.written && uses(one.written)).map(one => ({ kind: 'layout', id: one.id, written: one.written, arranged: one.arrangement, expanded: one.expanded ?? null })),
      ...Object.entries(screenParts(current)).filter(([, entry]) => uses(entry.written)).map(([screen, entry]) => ({ kind: 'screen', id: screen, written: entry.written, arranged: current[`${arranging.kept_prefix}${screen}`], expanded: entry.expanded ?? null })),
    ];
  }
  // A user rearranged by hand since it was expanded is never expanded over (invariant 8).
  const rearranged = user => user.expanded !== null && identityOf(user.arranged) !== user.expanded;
  // `users` expanded again from writtenOf(user) over `kept` ({ layouts, parts }): the layouts and screen parts after it,
  // the screen writes, and which users were expanded (done) or left as they were (refused, with why).
  async function reexpand(kept, users, writtenOf) {
    const nextLayouts = [...kept.layouts], parts = { ...kept.parts }, writes = [], done = [], refused = [];
    const offeredRows = await offered();
    for (const user of users) {
      if (rearranged(user)) { refused.push({ [user.kind === 'layout' ? 'layout_id' : 'screen']: user.id, why: 'rearranged by hand since it was expanded' }); continue; }
      const written = writtenOf(user);
      try {
        const { arrangement, used } = await expandWritten(written, nextLayouts, user.kind === 'layout' ? [user.id] : []);
        if (user.kind === 'layout') {
          const at = nextLayouts.findIndex(one => one.id === user.id);
          const [decoded] = readStarterLayouts([{ ...nextLayouts[at], arrangement }]);
          if (!decoded) throw new Error(shapeError);
          nextLayouts[at] = { ...nextLayouts[at], arrangement: decoded.arrangement, written, uses: used, expanded: identityOf(decoded.arrangement), edit: (nextLayouts[at].edit ?? 0) + 1, made_at: now().toISOString() };
        } else {
          const [decoded] = readStarterLayouts([{ id: `arranged-${slug(user.id)}`, name: user.id, arrangement }]);
          const state = decoded && starterLayoutState(decoded, readPlaceableSurfaces(offeredRows));
          if (!state) throw new Error('None of the screens that arrangement names can be shown.');
          writes.push({ address_label: `${arranging.kept_prefix}${user.id}`, payload: state });
          parts[user.id] = { written, uses: used, expanded: identityOf(state) };
        }
        done.push({ [user.kind === 'layout' ? 'layout_id' : 'screen']: user.id, uses: used });
      } catch (error) {
        refused.push({ [user.kind === 'layout' ? 'layout_id' : 'screen']: user.id, why: error.message });
      }
    }
    return { layouts: nextLayouts, parts, writes, done, refused };
  }
  // Expands again every user following `part` unpinned, then whoever follows the layouts that changed, over `kept`.
  async function follow(current, kept, part) {
    let state = { ...kept, writes: [], done: [], refused: [] };
    const queue = [part], seen = new Set();
    while (queue.length) {
      const changed = queue.shift();
      const users = usersOf({ ...current, [PARTS]: state.parts }, state.layouts, changed)
        .filter(user => !seen.has(`${user.kind}:${user.id}`) && user.id !== part && partsUsedBy(user.written).some(use => use.layout === changed && use.version === null));
      if (!users.length) continue;
      for (const user of users) seen.add(`${user.kind}:${user.id}`);
      const next = await reexpand(state, users, user => user.written);
      state = { layouts: next.layouts, parts: next.parts, writes: [...state.writes, ...next.writes], done: [...state.done, ...next.done], refused: [...state.refused, ...next.refused] };
      queue.push(...next.done.filter(one => one.layout_id).map(one => one.layout_id));
    }
    return state;
  }
  // The parts a user uses, each with the version it is pinned to, the part's version now and whether an update waits.
  const usesNow = async (used, cache = new Map()) => {
    const answer = [];
    for (const use of used ?? []) {
      const latest = await versionNow(use.layout, cache);
      answer.push({ ...use, latest, update_available: latest !== null && use.pinned !== null && (use.pinned !== latest || use.fell_back === true) });
    }
    return answer;
  };

  async function read() {
    const current = readRecords();
    const screens = (await offered()).map(row => ({ screen_id: row.id, label: typeof row.label === 'string' ? row.label : row.id, ...(row.icon ? { icon: row.icon } : {}) }));
    const shown = current[settings.shown_label] && typeof current[settings.shown_label] === 'object' ? current[settings.shown_label] : null;
    const kept = ownLayouts(current);
    const cache = new Map(), layouts = [];
    for (const layout of kept) {
      layouts.push({ layout_id: layout.id, identity: identityOf(layout), edit: layout.edit ?? 0, version: await versionNow(layout.id, cache), name: layout.name, icon: layout.icon ?? null, category: library.categoryOf(current, layout.id), arrangement: layout.arrangement,
        ...(layout.written ? { written: layout.written, uses: await usesNow(layout.uses, cache) } : {}), held: layout.held ?? null, by: layout.by ?? null, made_at: layout.made_at ?? null });
    }
    const screenUses = screenParts(current), screenUsesNow = new Map();
    for (const [screen, entry] of Object.entries(screenUses)) screenUsesNow.set(screen, await usesNow(entry.uses, cache));
    // Every part with a newer version than some layout or screen is pinned to, and who is behind (invariant 8).
    const behind = new Map();
    for (const [where, id, used] of [...layouts.filter(one => one.uses).map(one => ['layout_id', one.layout_id, one.uses]), ...[...screenUsesNow].map(([screen, used]) => ['screen', screen, used])]) {
      for (const use of used.filter(one => one.update_available)) {
        const entry = behind.get(use.layout) ?? { part: use.layout, latest: use.latest, layouts: [], screens: [] };
        (where === 'layout_id' ? entry.layouts : entry.screens).push({ [where]: id, pinned: use.pinned });
        behind.set(use.layout, entry);
      }
    }
    return {
      screens,
      opens_one_thing: oneThingScreens().map(row => ({ screen_id: row.id, label: typeof row.label === 'string' ? row.label : row.id, input: row.route_input })),
      layouts,
      categories: library.categories(current).map(({ members, ...category }) => ({ ...category, layouts: members })),
      recent: library.recent(kept.map(layout => ({ id: layout.id, saved_at: layout.made_at }))),
      current: shown?.arrangement ?? null,
      arranged: Object.entries(current).filter(([label, value]) => label.startsWith(arranging.kept_prefix) && value && typeof value === 'object')
        .map(([label, value]) => { const screen = label.slice(arranging.kept_prefix.length), entry = screenUses[screen];
          return { screen, identity: identityOf(value), arrangement: starterArrangementOf(value), ...(entry ? { written: entry.written, uses: screenUsesNow.get(screen) } : {}) }; })
        .filter(one => one.arrangement),
      current_shown_at: shown?.shown_at ?? null,
      updates_available: [...behind.values()],
      arrangement_shape: settings.arrangement_shape,
      parts_shape: settings.parts._what,
      said: `${layouts.length} layout${layouts.length === 1 ? '' : 's'} your AIs made; ${screens.length} screens a layout can hold.`,
    };
  }

  const openAsked = (id, by) => ({ address_label: settings.open_label, payload: { layout_id: id, asked_at: now().toISOString(), by: by ?? null } });

  // A screen's own arrangement (invariant 5): built as the page builds one, kept where the screen reads it.
  async function arrangeScreen(input) {
    const screen = text(input.screen);
    const rows = await offered();
    if (!rows.some(row => row.id === screen) && !surfaces.surfaces.some(row => row.id === screen)) throw new Error(`There is no screen ${screen}; read_layouts lists the screens.`);
    const label = `${arranging.kept_prefix}${screen}`;
    const keptNow = () => readRecords()[label];
    const current = readRecords(), parts = screenParts(current);
    const withoutParts = () => { const next = { ...parts }; delete next[screen]; return next; };
    if (input.layout === null || input.layout?.arrangement === null) {
      return commit(() => {
        refuseStale(input.expected_identity, keptNow(), `The arrangement of ${screen}`);
        records.write([{ address_label: label, payload: null }, ...(parts[screen] ? [{ address_label: PARTS, payload: withoutParts() }] : [])]);
        return { screen, arranged: null, said: `Put ${screen} back as it started.` };
      }, { operation: 'layouts:save' });
    }
    const written = input.layout?.arrangement;
    const { arrangement, used } = await expandWritten(written, ownLayouts(current), []);
    const [decoded] = readStarterLayouts([{ id: `arranged-${slug(screen)}`, name: screen, arrangement }]);
    if (!decoded) throw new Error(shapeError);
    const own = ownPiecesOf([...surfaces.surfaces, ...rows].find(row => row.id === screen));
    const unknown = await unknownIn(decoded.arrangement, own);
    if (unknown.length) throw new Error(unknownError(unknown));
    const state = starterLayoutState(decoded, readPlaceableSurfaces([...surfaces.surfaces, ...rows]));
    if (!state) throw new Error('None of the screens that arrangement names can be shown; read_layouts lists the screens.');
    return commit(() => {
      refuseStale(input.expected_identity, keptNow(), `The arrangement of ${screen}`);
      records.write([{ address_label: label, payload: state },
        ...(used ? [{ address_label: PARTS, payload: { ...parts, [screen]: { written, uses: used, expanded: identityOf(state) } } }] : parts[screen] ? [{ address_label: PARTS, payload: withoutParts() }] : [])]);
      return { screen, arranged: starterArrangementOf(state), ...(used ? { uses: used } : {}), said: `Arranged ${screen}; it shows that way now wherever it is open.` };
    }, { operation: 'layouts:save' });
  }

  async function unknownIn(arrangement, own = []) {
    const known = new Set([...(await offered()).map(one => one.id), ...own]);
    const oneThing = new Map(oneThingScreens().map(row => [row.id, row.route_input]));
    const queried = queryInputs();
    // An input key a known screen takes without naming one thing: what it kept in that placement, or what its address's
    // query opens it with.
    const narrowable = new Set(surfaces.surfaces.filter(row => row.package_entry?.entry_name === surfaces.narrowing.entry).map(row => row.id));
    const takes = (id, key) => key === 'kept' || Boolean(queried.get(id)?.has(key)) || (narrowable.has(id) && surfaces.narrowing.fields.includes(key));
    return surfacesIn(arrangement)
      // An entry with an input is a screen that opens one thing on it, or any screen carrying only what it kept in that
      // placement (`kept`, parts/ui/show/placement-kept) and what its address's query opens it with (route_query).
      .filter(entry => (typeof entry === 'string' ? !known.has(entry) : !((oneThing.has(entry.id) && entry.input[oneThing.get(entry.id)] !== undefined) || (known.has(entry.id) && Object.keys(entry.input).every(key => takes(entry.id, key)) && Object.keys(entry.input).length > 0))))
      .map(entry => (typeof entry === 'string' ? entry : `${entry.id} on ${JSON.stringify(entry.input)}`));
  }

  // `kept` among `rest` (layouts without what it replaces): where the first thing it replaced sat, else first.
  const place = (layouts, rest, kept) => {
    const at = layouts.findIndex(one => !rest.includes(one));
    if (at < 0) return [kept, ...rest];
    const before = layouts.slice(0, at).length;
    return [...rest.slice(0, before), kept, ...rest.slice(before)];
  };

  async function save(input = {}) {
    if (text(input.screen)) return arrangeScreen(input);
    const layout = input.layout && typeof input.layout === 'object' ? input.layout : {};
    const name = text(layout.name);
    if (!name) throw new Error('layout needs name: what the arrangement is for, in a few words.');
    const current = readRecords();
    const layouts = ownLayouts(current);
    const asked = text(layout.id);
    const earlier = layouts.find(one => one.id === asked || one.id === `${settings.id_prefix}${slug(asked)}`) ?? null;
    // A held thing (invariant 6) is one layout: `held` is its key, and `replaces` the names earlier copies of it were kept
    // under before they carried the key. Every copy of it leaves in the write that keeps this one.
    const held = text(layout.held);
    const replaces = Array.isArray(layout.replaces) ? layout.replaces.map(text).filter(Boolean).map(one => `${settings.id_prefix}${slug(one)}`) : [];
    const sameHeld = one => Boolean(held) && (one.held === held || (!one.held && replaces.includes(one.id)));
    const id = earlier?.id ?? `${settings.id_prefix}${slug(asked || name) || crypto.randomUUID()}`;
    const rest = layouts.filter(one => one.id !== id && !sameHeld(one));
    if (rest.length >= settings.layouts_max) throw new Error(`The person keeps at most ${settings.layouts_max} layouts your AIs made; remove one first (remove: true).`);
    const by = text(input.by) || null;
    const written = layout.arrangement;
    const { arrangement, used } = await expandWritten(written, layouts, [id]);
    const row = { id, name, ...(text(layout.icon) ? { icon: text(layout.icon) } : { icon: settings.default_icon }), arrangement };
    const [decoded] = readStarterLayouts([row]);
    if (!decoded) throw new Error(shapeError);
    const unknown = await unknownIn(decoded.arrangement);
    if (unknown.length) throw new Error(unknownError(unknown));
    const kept = { ...decoded, ...(used ? { written, uses: used, expanded: identityOf(decoded.arrangement) } : {}), ...(held ? { held } : {}), by: by ?? earlier?.by ?? null, made_at: now().toISOString(), edit: (earlier?.edit ?? 0) + 1 };
    const category = text(input.category);
    // Every layout and screen that follows this one (a use without a version) is expanded again over it, and in turn
    // whatever follows those (invariant 8).
    const followed = await follow(current, { layouts: place(layouts, rest, kept), parts: screenParts(current) }, id);
    return commit(() => {
      refuseStale(input.expected_identity, ownLayouts(readRecords()).find(one => one.id === id), `The layout ${id}`);
      records.write([
        { address_label: settings.layouts_label, payload: followed.layouts },
        ...followed.writes,
        ...(followed.writes.length ? [{ address_label: PARTS, payload: followed.parts }] : []),
        ...(category ? library.file(current, id, category) : []),
        ...(input.open_now === true ? [openAsked(id, by)] : []),
      ]);
      return {
        layout: { layout_id: id, identity: identityOf(kept), edit: kept.edit, name, category: category || library.categoryOf(current, id), screens: surfacesIn(decoded.arrangement).map(starterSurfaceId), ...(used ? { uses: used } : {}) },
        ...(followed.done.length || followed.refused.length ? { followed: followed.done, not_followed: followed.refused } : {}),
        said: `${earlier || rest.length < layouts.length ? 'Changed' : 'Kept'} the layout ${name} in the person's Layouts menu${input.open_now === true ? '; it opens now on their open Trillion page, and the arrangement it replaces is kept as Previous layout' : ''}.`,
      };
    }, { operation: 'layouts:save' });
  }

  async function remove(input = {}) {
    const id = text(input.layout_id);
    const current = readRecords();
    const layouts = ownLayouts(current);
    if (!layouts.some(one => one.id === id)) throw new Error(`There is no layout ${id || '(none named)'}; read_layouts gives every layout_id.`);
    // A part others use leaves only when its arrangement is written into each of them (invariant 8).
    const users = usersOf(current, layouts, id).filter(user => user.id !== id);
    if (users.length && input.detach_users !== true) {
      throw Object.assign(new Error(`The layout ${id} is a part of ${users.map(user => `${user.kind} ${user.id}`).join(', ')}; remove it with detach_users: true to write its arrangement into each of them, or remove it from them first.`),
        { status: 409, refused: { code: 'part_in_use', users: users.map(user => ({ [user.kind === 'layout' ? 'layout_id' : 'screen']: user.id })) } });
    }
    const resolve = resolverOver(layouts);
    const detachedWritten = new Map();
    for (const user of users) detachedWritten.set(`${user.kind}:${user.id}`, await inlinePart(user.written, id, resolve));
    const detached = await reexpand({ layouts, parts: screenParts(current) }, users, user => detachedWritten.get(`${user.kind}:${user.id}`));
    if (detached.refused.length) throw Object.assign(new Error(`The layout ${id} could not be written into ${detached.refused.map(one => `${one.layout_id ?? one.screen} (${one.why})`).join(', ')}.`), { status: 409, refused: { code: 'part_in_use', users: detached.refused } });
    return commit(() => {
      refuseStale(input.expected_identity, ownLayouts(readRecords()).find(one => one.id === id), `The layout ${id}`);
      records.write([{ address_label: settings.layouts_label, payload: detached.layouts.filter(one => one.id !== id) }, ...library.unfile(current, id),
        ...detached.writes, ...(users.some(user => user.kind === 'screen') ? [{ address_label: PARTS, payload: detached.parts }] : [])]);
      return { removed: id, ...(users.length ? { detached: detached.done } : {}), said: `Removed the layout ${id} from the Layouts menu${users.length ? `; its arrangement is now written into ${users.length} that used it` : ''}.` };
    }, { operation: 'layouts:remove' });
  }

  // Re-pins every use of `part` in the named layouts and screens (all pinned to it when none are named) to `version`
  // (the part's version now when left out) and expands them again (invariant 8).
  async function sync(input = {}) {
    const part = text(input.part);
    const current = readRecords(), layouts = ownLayouts(current);
    if (!layouts.some(one => one.id === part)) throw new Error(`There is no layout ${part || '(none named)'}; read_layouts gives every layout_id.`);
    const version = input.version === undefined || input.version === null ? await versionNow(part) : input.version;
    if (version === null) throw Object.assign(new Error('Layout versions are kept by the account\'s own records; this road does not keep them.'), { status: 501 });
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('version is a version number of the part, as read_layouts gives it (version).');
    const chosen = Array.isArray(input.layouts) || Array.isArray(input.screens);
    // Named users are re-pinned whatever they were; without names, those pinned to some version of the part.
    const pick = user => (chosen ? (user.kind === 'layout' ? input.layouts ?? [] : input.screens ?? []).map(text).includes(user.id)
      : partsUsedBy(user.written).some(use => use.layout === part && use.version !== null));
    const users = usersOf(current, layouts, part).filter(user => user.id !== part && pick(user));
    if (!users.length) throw new Error(`Nothing named uses the layout ${part} as a part; read_layouts lists what uses it (uses, updates_available).`);
    const synced = await reexpand({ layouts, parts: screenParts(current) }, users, user => pinPart(user.written, part, version));
    return commit(() => {
      records.write([{ address_label: settings.layouts_label, payload: synced.layouts }, ...synced.writes,
        ...(users.some(user => user.kind === 'screen') ? [{ address_label: PARTS, payload: synced.parts }] : [])]);
      return { synced: synced.done, refused: synced.refused, said: `Pinned ${synced.done.length} to version ${version} of ${part}${synced.refused.length ? `; ${synced.refused.length} left as they were` : ''}.` };
    }, { operation: 'layouts:sync' });
  }

  // Where a layout or a screen's own arrangement is versioned (invariant 9): { address, scope_id, what }.
  function versioned(input) {
    if (!versions) throw Object.assign(new Error('Layout versions are kept by the account\'s own records; this road does not keep them.'), { status: 501 });
    const screen = text(input.screen), id = text(input.layout_id);
    if (screen) return { address: `${arranging.kept_prefix}${screen}`, scope_id: SCREEN_MEMBER, what: { screen } };
    if (!id) throw new Error('Say which layout (layout_id) or screen (screen); read_layouts gives both.');
    return { address: settings.layouts_label, scope_id: id, what: { layout_id: id } };
  }
  async function history(input = {}) {
    const where = versioned(input);
    const page = await versions.history(where.address, { scope_id: where.scope_id, ...(input.kind ? { kind: input.kind } : {}), ...(input.before ? { before: input.before } : {}) });
    return { ...where.what, owner_type: page.owner_type, versions: page.revisions, current_identity: page.current_identity, next_cursor: page.next_cursor,
      said: `${page.revisions.length} kept version${page.revisions.length === 1 ? '' : 's'}; restore one with its id as revision_id.` };
  }
  async function keep(input = {}) {
    const where = versioned(input);
    return commit(() => {
      const kept = versions.keep({ address: where.address, scope_id: where.scope_id, ...(input.kind ? { kind: input.kind } : {}) });
      return { ...where.what, kept, said: `Kept this version as ${kept.kind}.` };
    }, { operation: 'layouts:keep' });
  }
  // Puts a kept version back exactly as it was (its expansion and pins included), as the kept layout or the screen's
  // arrangement; opening it is a separate step. Warns of every screen and part it names that is gone (invariant 9).
  async function restore(input = {}) {
    const where = versioned(input);
    const revision = await versions.revision(text(input.revision_id));
    if (!revision || revision.address !== where.address || revision.scope_id !== where.scope_id) throw new Error('That version is not one of this layout\'s; history lists its versions.');
    const current = readRecords(), layouts = ownLayouts(current);
    const value = revision.value;
    const arrangement = where.what.screen ? starterArrangementOf(value) : value.arrangement;
    const warnings = [];
    if (arrangement) for (const gone of await unknownIn(arrangement, where.what.screen ? ownPiecesOf((await offered()).find(row => row.id === where.what.screen)) : [])) warnings.push({ code: 'screen_gone', screen: gone, said: `${gone} is no longer a screen this person has; its pane stays empty until it is replaced.` });
    for (const use of partsUsedBy(value.written ?? null)) {
      if (!layouts.some(one => one.id === use.layout)) warnings.push({ code: 'part_gone', part: use.layout, said: `The part ${use.layout} no longer exists; this version keeps its arrangement as it was, but it no longer follows it.` });
    }
    if (where.what.screen) {
      const parts = screenParts(current);
      if (parts[where.what.screen]) warnings.push({ code: 'parts_not_followed', said: 'This screen was arranged with parts; the version put back is kept as it was and follows no part.' });
      return commit(() => {
        refuseStale(input.expected_identity, readRecords()[where.address], `The arrangement of ${where.what.screen}`);
        const rest = { ...parts };
        delete rest[where.what.screen];
        records.write([{ address_label: where.address, payload: value }, ...(parts[where.what.screen] ? [{ address_label: PARTS, payload: rest }] : [])]);
        return { screen: where.what.screen, arranged: starterArrangementOf(value), warnings, said: `Put back an earlier arrangement of ${where.what.screen}.` };
      }, { operation: 'layouts:restore' });
    }
    const earlier = layouts.find(one => one.id === where.scope_id) ?? null;
    if (!earlier && layouts.length >= settings.layouts_max) throw new Error(`The person keeps at most ${settings.layouts_max} layouts your AIs made; remove one first (remove: true).`);
    const restored = { ...value, edit: (earlier?.edit ?? value.edit ?? 0) + 1, made_at: now().toISOString(), restored_from: revision.id };
    return commit(() => {
      refuseStale(input.expected_identity, ownLayouts(readRecords()).find(one => one.id === where.scope_id), `The layout ${where.scope_id}`);
      records.write([{ address_label: settings.layouts_label, payload: earlier ? layouts.map(one => (one.id === where.scope_id ? restored : one)) : [...layouts, restored] }]);
      return { layout: { layout_id: restored.id, identity: identityOf(restored), edit: restored.edit, name: restored.name }, warnings,
        said: `Put back version ${revision.number} of the layout ${restored.name}; open it to see it.` };
    }, { operation: 'layouts:restore' });
  }

  async function open(input = {}) {
    const id = text(input.layout_id);
    if (!id) throw new Error('Say which layout with layout_id; read_layouts gives every layout_id.');
    return commit(() => {
      records.write([openAsked(id, text(input.by) || null)]);
      return { opened: id, said: `The layout ${id} opens now on the person's open Trillion page.` };
    }, { operation: 'layouts:open' });
  }

  return { read, save, remove, open, sync, history, keep, restore };
}

/** The /layouts routes over `layouts` (makeLayouts), answered by the account's own records resource. */
export async function handleLayoutsRequest(layouts, request) {
  const path = new URL(request.url).pathname;
  const verb = path === '/layouts' ? 'read' : path.slice('/layouts/'.length);
  if (!Object.hasOwn(layouts, verb) || (request.method === 'GET') !== (verb === 'read')) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    return Response.json(await layouts[verb](request.method === 'GET' ? {} : await request.json().catch(() => ({}))));
  } catch (error) {
    // A failure that tries again later is the shared failure owner's to answer, never a refusal of this request.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message, ...(error.refused ? { refused: error.refused } : {}) }, { status: error.status === 409 ? 409 : 400 });
  }
}
