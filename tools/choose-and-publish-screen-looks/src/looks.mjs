// src/looks.mjs
//
// PURPOSE
//   The person's screen looks, for every AI and every screen: which looks they can wear (the app's own, from
//   src/workspace/looks.json, and their own), which one they wear, wearing one, making a new look or changing one's
//   colours, sizes and fonts, a look as a record to download or hand to another app, and publishing one of their own on
//   the shared shelf (src/pool.mjs publishRow, shelf `look`) or withdrawing it. A look someone else published can be
//   worn by anyone: wearing it keeps it among their own looks. The Screen look screen (parts/screen-look) reads and
//   writes the same two records, so a look an AI wears repaints the open workspace (src/workspace/records.ts follows
//   the store's changes).
//
//   GET  /looks                 { worn, looks: [look summary], said }
//   POST /looks/read    { look_id }                                 { look, record, file_name }
//   POST /looks/wear    { look_id }                                 { worn, look, said }
//   POST /looks/save    { look_id? | from?, name?, description?, tokens?: { <token key>: value }, colours?: { base, accent, contrast? }, wear? }
//                                                                   { look, record, said }
//   POST /looks/publish { look_id }                                 { published: look_id, said }
//   POST /looks/withdraw { look_id }                                { withdrawn, said }
//   POST /looks/shelf { offset?, limit?, query? }                    { looks, total, offset, limit, next_offset } (bounded native Marketplace rows)
//   POST /looks/over_time { preset? | points?, on?, place?, time_zone?, hold? }
//                                                                   { plan, presets, anchors, said } (read with {})
//   GET  /looks/rules                                               { rules, everywhere_else, hosts, devices, facts, said }
//   POST /looks/set_rule { rule: { id?, label?, when?, look_id, time_zone? }, at?, move?: { id, to } }
//                                                                   { rules, said } (kept first unless `at`; the same id replaces)
//   POST /looks/remove_rule { id }                                  { rules, said }
//   GET  /looks/which?host=&device=&device_id=&place=&time_zone=    { look_id, rule_id, worn, said } (the look those facts wear)
//   GET  /looks/page[?host=&device=&place=]                         { worn, plan, looks: [look record] } (a self-painting page)
//   GET  /looks/device?time_zone=<zone>[&host=&device=&place=]      { worn, worn_record, now, ahead: [{ at, look }], looks, read_again_at }
//       Every look this person can wear as a device that cannot run CSS carries it (device-look-tokens deviceLook:
//       colours as 0-1 channels, lengths in points, faces by role, the primary button), and `now`, the look worn this
//       moment in that zone (a look plan's blend between two points included). The iPhone, the watch, the widgets, the
//       Live Activity, the Mac and the Chrome extension read it and repaint, so a look worn here reaches them all
//       without a new build; `worn_record` is the worn look's record for a page that runs the shared resolver itself
//       (the extension's pages); `read_again_at` is when `now` next changes (a plan's next point, or soon while it
//       blends); `ahead` is the look worn at each moment it changes over the next twelve hours, so a surface that draws without
//       reading (the Share sheet) wears the look of that moment, never a blend kept from its last read.
//
//   A look that changes over the day is a plan in the person's records (parts/screen-look/read-data/look-over-time.ts):
//   points in the day, each the look worn then; every screen they open blends between the points itself, so nothing is
//   written while the screen changes. Wearing a look while the plan is on holds that look until the plan's next point.
//
//   Where a look applies is the person's look rules (parts/screen-look/read-data/where-looks-apply.ts, record
//   where-looks-apply): an ordered list, each a formula-engine condition over the app a screen is drawn in, the kind of
//   device, the screen, the hour and weekday, and the look worn where it holds. The first rule that holds wins; when none
//   does, the worn look (what wear_look sets) is worn, so with no rules every screen wears the one worn look as before.
//   `page` and `device` take the screen's facts (host, device, device_id, place) and answer the look those facts wear;
//   a look a rule picked is pinned, so the day's plan does not move it. A page that wants the look for a screen server
//   side calls lookForFacts (the same pure function the page runs) or `which`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One format: a look is the record parts/screen-look/read-data/screen-look-record.ts defines, decoded and changed
//      only through it, so a look from a file, a tool or the shelf can never carry a value its token cannot take.
//   2. The records are the workspace's own (src/workspace/inputs.json names their labels): the worn look and the
//      person's own looks. The app's looks are never copied into a person's records, except as the edit they saved.
//   3. Only the person's own looks can be published, never an app look or an edit of one kept under the app look's id
//      (another account wearing it would replace their own look of that name); an id on the shelf has one maker.
//   4. Nothing here names a look, a colour or an app.
//
import inputs from './workspace/inputs.json' with { type: 'json' };
import appLooks from './workspace/looks.json' with { type: 'json' };
import { readScreenLookRecord } from '../../screen-looks/read-data/read-editable-screen-look-themes.ts';
import { changeScreenLookTokens, schemeOfScreenLook, screenLookFile, screenLookRecord, screenLookSlug, tintScreenLook } from '../../screen-looks/read-data/screen-look-record.ts';
import { wearRegister } from '../../screen-looks/read-data/type-register.ts';
import { resolveScreenLookButton, resolveScreenLookPalette } from '../../screen-looks/read-data/resolve-screen-look-palette.js';
import { deviceLook } from '../../screen-looks/read-data/device-look-tokens.js';
import { LOOK_RULES_RECORD, WHERE_LOOKS_APPLY, changeLookRules, lookForFacts, readLookRules, sayLookRules } from '../../screen-look/read-data/where-looks-apply.ts';
import { timeZoneName } from '../../run-work-later-or-on-a-repeat/do-work/wall-time.ts';
import { LOOK_OVER_TIME, LOOK_PLAN_RECORD, blendLookValues, changeLookPlan, lookAtTime, readLookPlan, sayLookPlan } from '../../screen-looks/read-data/look-over-time.ts';
import { themeChangesFor } from '../../screen-looks/read-data/theme-from-inputs.ts';
import { readabilityMisses, sayReadability } from '../../screen-look/read-data/look-readability.ts';
import readability from '../../screen-look/look-readability.json' with { type: 'json' };
import { failureOf, WorkFailure } from '../../shared-code/src/failure.mjs';

const WORN = inputs['current-screen-look'].address;
const PLAN = `workspace-preference:${LOOK_PLAN_RECORD}`;
const RULES = `workspace-preference:${LOOK_RULES_RECORD}`;
const OWN = inputs['own-screen-look-themes'].address;
export const LOOK_SHELF = 'look';
// The palette entries a look's summary names, so an AI can say what a look looks like without reading every token.
// The zone a device reads its looks in: the one it names, or UTC when it names none. A zone it names that is not one is
// refused, never read as UTC, so a device is never shown the look of a clock it is not on.
const deviceZone = value => {
  if (value === undefined || value === null || value === '') return 'UTC';
  const zone = timeZoneName(value);
  if (!zone) throw new Error(`${String(value)} is not a time zone; use one like America/Los_Angeles.`);
  return zone;
};
const SUMMARY_COLOURS = { background: '--bg-surface', text: '--text-primary', accent: '--accent-primary' };
// Who made a look, in the words the Marketplace's made_by_words read (src/marketplace-kinds.json).
const MADE_BY = { own: 'this account', app: 'Trillion', other: 'another account' };
// While a look plan blends between two points, how often a device reads `now` again.
const BLENDING_READ_MS = 15 * 60 * 1000;
// How far ahead a device is handed the look worn at each moment it changes, and how finely a blend is stepped.
const AHEAD_MS = 12 * 60 * 60 * 1000;
const AHEAD_STEP_MS = 10 * 60 * 1000;
// A blend ahead moves in these fractions of the way, so a long blend hands a device a few looks, never one per step.
const AHEAD_BLEND_STEPS = 10;
const SHELF_PAGE_SIZE = 60;
const SHELF_READERS = 4;
const NEW_ID_ATTEMPTS = 8;
const shelfUnavailable = () => new WorkFailure('service-interrupted', 'The current screen look shelf reader is unavailable. Try again shortly.');

const decoded = rows => (Array.isArray(rows) ? rows : []).map(readScreenLookRecord).filter(Boolean);
const APP = decoded(appLooks.themes);
const APP_IDS = new Set(APP.map(look => look.id));

function summary(look, madeBy, published) {
  const palette = resolveScreenLookPalette(look);
  return {
    look_id: look.id,
    name: look.name,
    description: look.description,
    made_by: madeBy,
    ...(published === undefined ? {} : { published }),
    colours: Object.fromEntries(Object.entries(SUMMARY_COLOURS).map(([name, variable]) => [name, palette[variable] ?? null])),
  };
}

/** The looks owner over one person's records. `records.read()` answers every workspace record by label and
 *  `records.write(writes)` replaces some; `shelf` is the shared shelf ({ published(shelf), publish({ shelf, row, maker
 *  }), withdraw({ shelf, id, maker }) }); optional native reads are one(shelf,id) → {maker,row}|null and
 *  publishedPage(shelf,{offset,limit,query}) → {rows,total}, or publishedCursorPage(shelf,{after,limit,query}) → {rows,total,complete,next}. Declaring any disables the whole-shelf fallback.
 *  `maker` is this account's opaque maker identity. `beforeMutation(operation,input)` rechecks current admission
 *  after awaited reads; `commitMutation(change,{operation})` synchronously commits local writes and their exact
 *  public response together. Publication and withdrawal retain the shelf owner's separate lifecycle. */
export function makeLooks({ records, shelf, maker, filterRows, now = () => new Date(), beforeMutation = async () => {}, commitMutation = change => change() }) {
  if (typeof commitMutation !== 'function' || commitMutation.constructor?.name === 'AsyncFunction')
    throw new TypeError('The screen look mutation commit supply must be synchronous.');
  const admitLocalMutation = async (operation, input) => {
    try { await beforeMutation(operation, input); }
    catch (error) {
      if ([401, 402, 403].includes(error?.status) && !failureOf(error).tries_again_later)
        throw Object.assign(new Error('Current access does not admit this screen look change.'), { status: error.status, look_access_refused: true });
      throw error;
    }
  };
  const commitLocalMutation = (operation, change) => {
    const result = commitMutation(change, { operation });
    if (result && typeof result.then === 'function') throw new TypeError('Screen look mutation commitments must be synchronous.');
    return result;
  };
  const readRecords = () => records.read([OWN, WORN, PLAN, RULES]);
  const own = () => decoded(readRecords()[OWN]);
  // Every look the person can wear: the app's in its order, a look of theirs with an app look's id in its place (their
  // edit of it), then their own.
  function wearable() {
    const mine = own();
    const byId = new Map(mine.map(look => [look.id, look]));
    return [...APP.map(look => byId.get(look.id) ?? look), ...mine.filter(look => !APP_IDS.has(look.id))];
  }
  const wornId = () => {
    const row = (readRecords()[WORN] ?? [])[0];
    return typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : appLooks.start_with;
  };
  // Each wearable look's summary: a look of the person's own (not an edit of an app look) says whether it is published.
  function summaries(looks, published) {
    const mine = new Set(own().map(look => look.id));
    return looks.map(look => (mine.has(look.id) && !APP_IDS.has(look.id)
      ? summary(look, MADE_BY.own, published.has(look.id))
      : summary(look, MADE_BY.app)));
  }
  const boundedShelf = typeof shelf.one === 'function' || typeof shelf.publishedPage === 'function' || typeof shelf.publishedCursorPage === 'function';
  const publishedOne = async id => {
    if (typeof shelf.one !== 'function') throw shelfUnavailable();
    const item = await shelf.one(LOOK_SHELF, id);
    if (item !== null && (!item || item.row?.id !== id || typeof item.maker !== 'string' || !item.maker)) throw shelfUnavailable();
    return item;
  };
  async function publishedIds(looks = wearable(), kept = []) {
    const ids = new Set(looks.map(look => look.id));
    const candidates = [...new Set([...own(), ...kept].filter(look => ids.has(look.id) && !APP_IDS.has(look.id)).map(look => look.id))];
    if (!candidates.length) return new Set();
    if (!boundedShelf) return new Set((await shelf.published(LOOK_SHELF)).filter(item => item.maker === maker).map(item => item.row.id));
    const published = new Set();
    for (let offset = 0; offset < candidates.length; offset += SHELF_READERS) {
      const batch = candidates.slice(offset, offset + SHELF_READERS);
      const rows = await Promise.all(batch.map(publishedOne));
      for (let i = 0; i < batch.length; i += 1) if (rows[i]?.maker === maker) published.add(batch[i]);
    }
    return published;
  }
  // Legacy owners alone expose a whole shelf. Native exact reads never scan it.
  async function othersPublished() {
    return (await shelf.published(LOOK_SHELF)).filter(item => item.maker !== maker)
      .map(item => readScreenLookRecord(item.row.record)).filter(Boolean);
  }
  const lookId = input => {
    const id = typeof input?.look_id === 'string' ? input.look_id.trim() : '';
    if (!id) throw new Error('Say which look: its look_id from list_looks.');
    return id;
  };
  async function find(id) {
    let look = wearable().find(one => one.id === id);
    if (!look && boundedShelf) {
      const item = await publishedOne(id);
      if (item && item.maker !== maker) {
        const decoded = readScreenLookRecord(item.row.record);
        if (decoded?.id === id) look = decoded;
      }
    } else if (!look) look = (await othersPublished()).find(one => one.id === id);
    if (!look) throw new Error(`There is no look ${id}. Read list_looks for the looks there are.`);
    return look;
  }
  function keepOwn(look) {
    records.write([{ address_label: OWN, payload: [...own().filter(one => one.id !== look.id).map(screenLookRecord), screenLookRecord(look)] }]);
  }
  const readPlan = () => readLookPlan(readRecords()[PLAN]);
  const readRules = () => readLookRules(readRecords()[RULES]);
  function rulesResponse() {
    const looks = wearable();
    const nameOf = id => looks.find(look => look.id === id)?.name ?? id;
    const rules = readRules();
    const everywhereElse = { id: WHERE_LOOKS_APPLY.default_rule.id, label: WHERE_LOOKS_APPLY.default_rule.label, look_id: wornId() };
    const named = list => list.map(({ id, label }) => ({ id, label }));
    return {
      rules,
      everywhere_else: everywhereElse,
      hosts: named(WHERE_LOOKS_APPLY.hosts),
      devices: named(WHERE_LOOKS_APPLY.devices),
      facts: WHERE_LOOKS_APPLY.facts.map(({ id, label, kind, choices }) => ({ id, label, kind, ...(choices ? { choices } : {}) })),
      said: sayLookRules(rules, everywhereElse.look_id, nameOf),
    };
  }
  // The facts a screen says about itself (query or body): only the ones where-looks-apply.json declares for the screen.
  const factsOf = input => Object.fromEntries(['host', 'device', 'device_id', 'place'].map(name => [name, typeof input?.[name] === 'string' && input[name].trim() ? input[name].trim() : null]));
  // The look those facts wear, by the person's look rules over `filterRows` (the formula engine), else the worn look; a
  // rule's look the person no longer has lets the worn look through. Without facts there is nothing for a rule to hold on.
  async function wornFor(input) {
    const rules = readRules();
    const facts = factsOf(input);
    const ids = new Set(wearable().map(look => look.id));
    const zone = deviceZone(input?.time_zone);
    const answer = rules.length && filterRows && Object.values(facts).some(Boolean)
      ? await lookForFacts({ rules: rules.filter(rule => ids.has(rule.look_id)), facts, accountLook: wornId(), now: now().getTime(), filterRows, zone })
      : { look_id: wornId(), rule_id: null, next_change_at: null };
    return { ...answer, facts };
  }
  // Wearing a look while the look plan is on holds it until the plan's next point (worked out on each screen, in its own
  // zone), so the plan never takes back a look the person or their AI just picked; it carries on by itself from there.
  function wearId(id) {
    const plan = readPlan();
    records.write([
      { address_label: WORN, payload: [{ name: id }] },
      ...(plan?.on ? [{ address_label: PLAN, payload: { ...plan, hold: { kind: 'worn', since: now().toISOString() } } }] : []),
    ]);
  }
  // Keep a readable name when free. Native collisions use opaque suffixes and
  // bounded exact checks, never a walk through the public Marketplace.
  async function freshId(name) {
    const base = screenLookSlug(name) || 'my-look';
    if (!boundedShelf) {
      const taken = new Set([...wearable(), ...(await othersPublished())].map(look => look.id));
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
      return id;
    }
    const taken = new Set(wearable().map(look => look.id));
    for (let attempt = 0; attempt < NEW_ID_ATTEMPTS; attempt += 1) {
      const id = attempt === 0 ? base : `${base}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      if (!taken.has(id) && !(await publishedOne(id))) return id;
    }
    throw new WorkFailure('service-busy', 'A free screen look identity could not be confirmed. Try saving again shortly.');
  }

  const verbs = {
    async list() {
      const published = await publishedIds();
      const worn = wornId();
      const looks = summaries(wearable(), published);
      const wearing = looks.find(look => look.look_id === worn);
      return { worn, looks, said: `${looks.length} looks; wearing ${wearing?.name ?? worn}.` };
    },
    async read(input) {
      const look = await find(lookId(input));
      return { look, record: screenLookRecord(look), file_name: screenLookFile(look).name };
    },
    async wear(input) {
      const look = await find(lookId(input));
      // A look from the shelf is kept among the person's own, so it stays theirs to wear and change.
      const keeping = !wearable().some(one => one.id === look.id);
      const published = await publishedIds([look], keeping ? [look] : []);
      await admitLocalMutation('looks:wear', input);
      return commitLocalMutation('looks:wear', () => {
        if (keeping) keepOwn(look);
        wearId(look.id);
        return { worn: look.id, look: summaries([look], published)[0], said: `Now wearing ${look.name}.` };
      });
    },
    async save(input = {}) {
      const editing = typeof input.look_id === 'string' && input.look_id.trim() ? await find(input.look_id.trim()) : null;
      const base = editing ?? await find(typeof input.from === 'string' && input.from.trim() ? input.from.trim() : wornId());
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : editing ? base.name : `${base.name} (yours)`;
      const description = typeof input.description === 'string' ? input.description.trim() : base.description;
      const given = input.tokens && typeof input.tokens === 'object' && !Array.isArray(input.tokens) ? input.tokens : {};
      // Three picks (base, accent, contrast) make a whole look; tokens named beside them win over what they derive.
      const generated = input.colours === undefined ? {} : themeChangesFor(base, input.colours && typeof input.colours === 'object' ? input.colours : {}).changes;
      const tokens = { ...generated, ...given };
      const id = editing ? editing.id : await freshId(name);
      // A type register moves every type role together, a picked colour tints the accent roles, then the tokens named one by one win.
      let themed = { ...base, id, name, description, author: MADE_BY.own, is_public: false };
      if (typeof input.register === 'string' && input.register) themed = wearRegister(themed, input.register);
      if (input.tint) {
        const picked = typeof input.tint === 'string' ? { colour: input.tint } : input.tint;
        themed = tintScreenLook(themed, picked.colour, picked.scheme ?? schemeOfScreenLook(themed));
      }
      const look = changeScreenLookTokens(themed, tokens);
      await admitLocalMutation('looks:save', input);
      return commitLocalMutation('looks:save', () => {
        keepOwn(look);
        if (input.wear !== false) wearId(look.id);
        const misses = readabilityMisses(look.tokens, readability);
        return { look, record: screenLookRecord(look), ...(misses.length ? { readability: misses } : {}), said: `${editing ? 'Changed' : 'Made'} ${look.name}${input.wear === false ? '' : ', now worn'}.${misses.length ? ` ${sayReadability(misses)}` : ''}` };
      });
    },
    async publish(input) {
      const id = lookId(input);
      const look = own().find(one => one.id === id);
      if (!look) throw new Error(`${id} is not one of your own looks. Only a look you made can be published.`);
      if (APP_IDS.has(id)) throw new Error(`${look.name} is your change to one of Trillion's looks. Save it as a new look (save_look with from: "${id}" and a name), then publish that.`);
      const misses = readabilityMisses(look.tokens, readability);
      if (misses.length && readability.refuse_publish) throw new Error(`${look.name} is not published. ${sayReadability(misses)} Change those colours with save_look, then publish it.`);
      await shelf.publish({ shelf: LOOK_SHELF, maker, row: { id, name: look.name, description: look.description, record: screenLookRecord(look) } });
      return { published: id, ...(misses.length ? { readability: misses } : {}), said: `${look.name} is published for everyone.${misses.length ? ` ${sayReadability(misses)}` : ''}` };
    },
    async withdraw(input) {
      const id = lookId(input);
      const withdrawn = await shelf.withdraw({ shelf: LOOK_SHELF, id, maker });
      return { withdrawn, said: withdrawn ? `${id} is withdrawn.` : `${id} was not published by you.` };
    },
    // The look plan: read it with no change, or change it (a starting plan by `preset`, its own `points`, `on`, a
    // `place` for points that follow the sun, a `time_zone`, a `hold`), checked the way every screen checks it.
    async over_time(input = {}) {
      const change = input ?? {};
      const changing = Object.keys(change).length > 0;
      const response = plan => {
        const looks = wearable();
        const nameOf = id => looks.find(look => look.id === id)?.name ?? id;
        return { plan, presets: LOOK_OVER_TIME.presets,
          anchors: LOOK_OVER_TIME.anchors.map(({ id, label }) => ({ id, label })),
          said: `${changing ? 'Saved. ' : ''}${sayLookPlan(plan, nameOf)}` };
      };
      if (!changing) return response(readPlan());
      // Validate before admission, then derive the final change from current
      // local state inside the synchronous commit after its awaited gate.
      changeLookPlan(readPlan(), change, wearable().map(look => look.id));
      await admitLocalMutation('looks:over_time', input);
      return commitLocalMutation('looks:over_time', () => {
        const plan = changeLookPlan(readPlan(), change, wearable().map(look => look.id));
        records.write([{ address_label: PLAN, payload: plan }]);
        return response(plan);
      });
    },
    // Every wearable look as a device carries it, the one worn now in the device's zone (input.time_zone), and the one
    // worn at each moment it changes over the next twelve hours (ahead), so a surface that draws without reading again (the
    // Share sheet, a widget) wears what every screen wears at that moment, never a blend kept from when it last read.
    async device(input = {}) {
      const looks = wearable();
      const byId = new Map(looks.map(look => [look.id, look]));
      const placed = await wornFor(input);
      const worn = byId.get(placed.look_id) ?? byId.get(wornId()) ?? looks[0];
      const palettes = new Map(looks.map(look => [look.id, resolveScreenLookPalette(look)]));
      const carried = look => deviceLook(look, palettes.get(look.id), resolveScreenLookButton(look));
      const zone = deviceZone(input?.time_zone);
      const plan = readPlan();
      // What decides the look worn at `at`: the worn look, or the plan's two looks and how far between them, while it
      // is on and not held to the worn look. A look worn while the plan is on holds until its next point (wearId).
      const momentAt = (at, steps = 0) => {
        const moving = lookAtTime(plan, at, zone);
        const [from, to] = moving ? [byId.get(moving.from), byId.get(moving.to)] : [null, null];
        if (!moving || !from || !to || moving.held?.kind === 'worn' || placed.rule_id) return { moving, key: `worn:${worn.id}` };
        const exact = from === to ? 1 : Math.min(1, Math.max(0, moving.t));
        const t = steps ? Math.round(exact * steps) / steps : exact;
        return { moving, from, to, t, key: t <= 0 ? `look:${from.id}` : t >= 1 ? `look:${to.id}` : `blend:${from.id}:${to.id}:${t}` };
      };
      const lookOf = ({ from, to, t }) => {
        if (!from) return carried(worn);
        if (t <= 0) return carried(from);
        if (t >= 1) return carried(to);
        const nearer = t < 0.5 ? from : to;
        return deviceLook(nearer, blendLookValues(palettes.get(from.id), palettes.get(to.id), t), resolveScreenLookButton(nearer));
      };
      const at = now();
      const first = momentAt(at);
      const { moving } = first;
      const wornNow = lookOf(first);
      const ahead = [];
      if (plan?.on) {
        let last = first.key;
        for (let step = 1; step * AHEAD_STEP_MS <= AHEAD_MS; step += 1) {
          const when = new Date(at.getTime() + step * AHEAD_STEP_MS);
          const moment = momentAt(when, AHEAD_BLEND_STEPS);
          if (moment.key !== last) { ahead.push({ at: when.toISOString(), look: lookOf(moment) }); last = moment.key; }
        }
      }
      const blending = moving && !placed.rule_id && moving.held?.kind !== 'worn' && moving.t > 0 && moving.t < 1;
      // A device reads again when the plan next changes, and when the hour a rule reads turns; a look a rule picked is
      // pinned, so the plan's points are not read for it.
      const planAgain = !moving || placed.rule_id ? null : blending ? Math.min(moving.next.getTime(), at.getTime() + BLENDING_READ_MS) : moving.next.getTime();
      const again = [planAgain, placed.next_change_at].filter(moment => moment !== null).reduce((soonest, moment) => (soonest === null || moment < soonest ? moment : soonest), null);
      return {
        worn: worn.id,
        worn_record: screenLookRecord(worn),
        now: wornNow,
        ahead,
        looks: looks.map(carried),
        read_again_at: again === null ? null : new Date(again).toISOString(),
      };
    },
    // What a page that paints itself needs to wear the same look as every other screen at the same moment
    // (read-data/look-now.ts): the worn look's id, the look plan, and the records of the looks those two name.
    async page(input = {}) {
      const looks = wearable();
      const placed = await wornFor(input);
      const worn = looks.find(look => look.id === placed.look_id) ?? looks.find(look => look.id === wornId()) ?? looks[0];
      // A look a rule picked is pinned: the page is not handed the plan that would move it.
      const plan = placed.rule_id ? null : readPlan();
      const named = new Set([worn.id, ...(plan?.on ? plan.points.map(point => point.look) : [])]);
      return { worn: worn.id, plan, looks: looks.filter(look => named.has(look.id)).map(screenLookRecord) };
    },
    // Where a look applies: the rules in the order they are read, the look worn everywhere else, and what a rule can name.
    async rules() {
      return rulesResponse();
    },
    // Keeps one look rule (first in the order unless `at`; the same id replaces it), or moves one, checked the way every
    // screen reads it; a rule with a problem is refused in words.
    async set_rule(input = {}) {
      const change = { save: input.rule, at: input.at, move: input.move };
      changeLookRules({ rules: readRules() }, change, wearable().map(look => look.id), now().getTime());
      await admitLocalMutation('looks:set_rule', input);
      return commitLocalMutation('looks:set_rule', () => {
        const next = changeLookRules({ rules: readRules() }, change, wearable().map(look => look.id), now().getTime());
        records.write([{ address_label: RULES, payload: next }]);
        const read = rulesResponse();
        return { ...read, said: `Saved. ${read.said}` };
      });
    },
    async remove_rule(input = {}) {
      const change = { remove: typeof input.id === 'string' ? input.id.trim() : '' };
      changeLookRules({ rules: readRules() }, change, wearable().map(look => look.id), now().getTime());
      await admitLocalMutation('looks:remove_rule', input);
      return commitLocalMutation('looks:remove_rule', () => {
        const next = changeLookRules({ rules: readRules() }, change, wearable().map(look => look.id), now().getTime());
        records.write([{ address_label: RULES, payload: next }]);
        const read = rulesResponse();
        return { ...read, said: `Removed. ${read.said}` };
      });
    },
    // The look a screen with these facts wears right now.
    async which(input = {}) {
      const placed = await wornFor(input);
      const look = wearable().find(one => one.id === placed.look_id);
      return { look_id: placed.look_id, rule_id: placed.rule_id, worn: wornId(), facts: placed.facts, said: `${look?.name ?? placed.look_id}${placed.rule_id ? ` (rule ${placed.rule_id})` : ' (everywhere else)'}.` };
    },
    // Native offsets/total describe the published discovery window, before
    // withdrawal/duplicate filtering. Local wearable extras appear on its first
    // page only; their count never shifts the public continuation cursor.
    async shelf(input = {}) {
      const mine = wearable();
      const seen = new Set(mine.map(look => look.id));
      if (!boundedShelf) return {
        looks: [
          ...summaries(mine, await publishedIds(mine)),
          ...(await othersPublished()).filter(look => !seen.has(look.id)).map(look => summary(look, MADE_BY.other)),
        ],
      };
      if (typeof shelf.publishedCursorPage === 'function') {
        const { after = 0, limit = SHELF_PAGE_SIZE, query = '' } = input;
        if ((input.offset !== undefined && input.offset !== 0) || !(after === 0 || typeof after === 'string' && after.length <= 8192)
          || !Number.isSafeInteger(limit) || limit < 1 || limit > SHELF_PAGE_SIZE || typeof query !== 'string')
          throw new Error(`Screen look shelf needs its original cursor, a limit from 1 to ${SHELF_PAGE_SIZE}, and an optional query string.`);
        const search = query.trim().slice(0, 200);
        const page = await shelf.publishedCursorPage(LOOK_SHELF, { after, limit, query: search });
        if (!Array.isArray(page?.rows) || page.rows.length > limit || !(page.total === null || Number.isSafeInteger(page.total) && page.total >= 0)
          || typeof page.complete !== 'boolean' || (page.complete ? page.next !== null : typeof page.next !== 'string' || !page.next || page.next.length > 8192 || page.next === after))
          throw shelfUnavailable();
        const looks = [];
        if (after === 0 || after === '') {
          const local = mine.filter(look => !search || JSON.stringify(look).toLowerCase().includes(search.toLowerCase()));
          looks.push(...summaries(local, await publishedIds(local)));
        }
        for (const item of page.rows) {
          if (item?.maker === maker) continue;
          const look = readScreenLookRecord(item?.row?.record);
          if (!look || look.id !== item.row.id || seen.has(look.id)) continue;
          seen.add(look.id); looks.push(summary(look, MADE_BY.other));
        }
        return { looks, total: page.total, after, limit, complete: page.complete, next: page.next };
      }
      const { offset = 0, limit = SHELF_PAGE_SIZE, query = '' } = input;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > SHELF_PAGE_SIZE || typeof query !== 'string')
        throw new Error(`Screen look shelf needs a nonnegative integer offset, a limit from 1 to ${SHELF_PAGE_SIZE}, and an optional query string.`);
      if (typeof shelf.publishedPage !== 'function') throw shelfUnavailable();
      const search = query.trim().slice(0, 200);
      const page = await shelf.publishedPage(LOOK_SHELF, { offset, limit, query: search });
      if (!Array.isArray(page?.rows) || page.rows.length > limit || !Number.isSafeInteger(page.total) || page.total < 0) throw shelfUnavailable();
      const looks = [];
      const matches = look => !search || JSON.stringify(look).toLowerCase().includes(search.toLowerCase());
      if (offset === 0) {
        const local = mine.filter(matches);
        looks.push(...summaries(local, await publishedIds(local)));
      }
      for (const item of page.rows) {
        if (item?.maker === maker) continue;
        const look = readScreenLookRecord(item?.row?.record);
        if (!look || look.id !== item.row.id || seen.has(look.id)) continue;
        seen.add(look.id); looks.push(summary(look, MADE_BY.other));
      }
      const after = offset + limit;
      return { looks, total: page.total, offset, limit, next_offset: after < page.total ? after : null };
    },
  };
  return verbs;
}

// The verbs read with GET (their input in the query); every other verb is a POST with a JSON body.
const READ_VERBS = new Set(['list', 'device', 'page', 'rules', 'which']);

/** The /looks routes over `looks` (makeLooks), answered by the account's own records resource. */
export async function handleLooksRequest(looks, request) {
  const url = new URL(request.url);
  const verb = url.pathname === '/looks' ? 'list' : url.pathname.slice('/looks/'.length);
  if (!Object.hasOwn(looks, verb) || (request.method === 'GET') !== READ_VERBS.has(verb)) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    return Response.json(await looks[verb](request.method === 'GET' ? Object.fromEntries(url.searchParams) : await request.json().catch(() => ({}))));
  } catch (error) {
    // A failure that tries again later is the shared failure owner's to answer, never a refusal of this request.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: error.look_access_refused === true ? error.status : 400 });
  }
}

const lookIdField = { type: 'string', description: 'A look_id from list_looks' };

/** The MCP tools over the person store's /looks routes. */
export const lookTools = call => [
  { name: 'list_looks', description: 'The screen looks this person can wear in Trillion (Trillion\'s own and the ones they made or took from the Marketplace) and which one they wear now. Each look has its look_id, name, description, made_by, its main colours (background, text, accent) and, for their own, whether it is published on the Marketplace. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/looks') },
  { name: 'read_look', description: 'One look in full: every token (its key, label, kind and value) you can change with save_look, and the look as a record (the .look.json file a person downloads or opens). It changes nothing.', inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: lookIdField } }, run: input => call('/looks/read', input) },
  { name: 'wear_look', description: 'Makes this person\'s Trillion wear a look everywhere they are signed in, except where one of their look rules (set_look_rule) picks another for an app, device, screen or time. A look another account published (from the Marketplace) is kept among their own looks first.', inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: lookIdField } }, run: input => call('/looks/wear', input) },
  { name: 'save_look', description: 'Makes a new look or changes one of this person\'s looks. With look_id it changes that look (a change to one of Trillion\'s looks is kept as their own version under the same id); without it, it makes a new look from `from` (a look_id, else the look worn now) under a new id from its name. register wears a type register and tint wears one picked colour (applied first); tokens sets token values by key (read_look lists them: colours as #hex or rgb(), numbers within their range). The saved look is worn unless wear is false.', inputSchema: {
    type: 'object',
    properties: {
      look_id: { type: 'string', description: 'The look to change; leave out to make a new one' },
      from: { type: 'string', description: 'The look a new one starts from; the worn look when left out' },
      name: { type: 'string' },
      description: { type: 'string' },
      tokens: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'Token key to its new value' },
      register: { type: 'string', description: 'A type register (compact or editorial): every type role of the look changes together; tokens named too still win' },
      tint: { type: ['string', 'object'], description: 'One picked colour as #rrggbb (or { colour, scheme: light|dark }): only its hue is kept and the accent roles are derived so text stays readable; tokens named too still win' },
      colours: { type: 'object', additionalProperties: false, required: ['base', 'accent'], properties: { base: { type: 'string', description: 'The page colour as #rrggbb; a dark one makes a dark look' }, accent: { type: 'string', description: 'The action colour as #rrggbb' }, contrast: { type: 'number', minimum: 0, maximum: 100, description: 'How far text sits from its ground, 0 to 100 (50 when left out)' } }, description: 'Makes the whole look from three picks: every colour it has is derived so text stays readable. Tokens given beside it win.' },
      wear: { type: 'boolean', description: 'false keeps the look now worn' },
    },
  }, run: input => call('/looks/save', input ?? {}) },
  { name: 'publish_look', description: 'Publishes one of this person\'s own looks on the Marketplace, where anyone can wear it. A change to one of Trillion\'s looks is saved as a new look first (save_look with from).', inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: lookIdField } }, run: input => call('/looks/publish', input) },
  { name: 'look_over_time', description: 'Reads or changes how this person\'s screen look changes over the day: points in the day, each a moment (by the clock, { clock: "21:00" }, or by the sun, { anchor: "sunset" | "sunrise" | "dawn" | "dusk", minutes: -30 }) and the look_id worn then; between two points every screen of theirs moves gradually from one look to the next on the device itself, in that device\'s time zone. With nothing given it returns the plan, the starting plans (presets) and the anchors. preset starts from a starting plan (evening-dims-to-black moves from Trillion to Trillion Black between 7pm and 10pm and back in the morning) and turns it on; points replaces the points; on turns it on or off; place { latitude, longitude } lets sun points work; time_zone pins one zone; hold { kind: "worn", since } keeps the worn look until the next point, null lets the plan carry on. Use it when the person says things like "dim the screen after 9pm".', inputSchema: {
    type: 'object',
    properties: {
      preset: { type: 'string', description: 'A starting plan id from presets' },
      points: { type: 'array', items: { type: 'object', required: ['at', 'look'], properties: { at: { type: 'object' }, look: lookIdField } } },
      on: { type: 'boolean' },
      place: { type: ['object', 'null'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
      time_zone: { type: ['string', 'null'], description: 'Like America/Los_Angeles; null follows each device' },
      hold: { type: ['object', 'null'] },
    },
  }, run: input => call('/looks/over_time', input ?? {}) },
  { name: 'read_look_rules', description: 'Where each look applies on this person\'s screens: their look rules in the order they are read (the first that holds wins), the look worn everywhere else (what wear_look sets), and what a rule can name: the app a screen is drawn in (a browser, the iPhone app, the Mac app, the Chrome extension, inside ChatGPT or Claude), the kind of device, a particular device, the screen or area of the app, the hour and weekday. With facts (host, device, device_id, place) it also says which look those facts wear. It changes nothing.', inputSchema: { type: 'object', properties: {
    host: { type: 'string', description: 'An app id from hosts, to ask which look it wears' },
    device: { type: 'string', description: 'A device id from devices' },
    device_id: { type: 'string' },
    place: { type: 'string', description: 'The screen or area of the app' },
    time_zone: { type: 'string', description: 'Like America/Los_Angeles; where hour and weekday are read' },
  } }, run: async input => {
    const asked = ['host', 'device', 'device_id', 'place'].some(name => input?.[name]);
    const rules = await call('/looks/rules');
    if (!asked) return rules;
    const params = new URLSearchParams(Object.entries(input).filter(([, value]) => typeof value === 'string' && value));
    return { ...rules, which: await call(`/looks/which?${params}`) };
  } },
  { name: 'set_look_rule', description: 'Keeps one look rule: wear a different look in one place, on one device, in one app or at one time, instead of one look everywhere. rule is { id?, label?, when?, look_id, time_zone? }: look_id is the look worn where the rule holds (list_looks), when (null: always) is the formula engine\'s tree { kind: "group", combinator: "and", negate: false, rules: [{ kind: "rule", field, operator, params }] } over the facts read_look_rules lists: host (chatgpt, claude, web, iphone, mac, chrome-extension), device (phone, tablet, computer, watch), device_id, place, hour 0-23 and weekday in the rule\'s time_zone, and now. The first rule that holds wins, a new rule goes first unless at (a place in the order) says otherwise, and the same id replaces a rule. Examples: Trillion Black inside ChatGPT: { label: "In ChatGPT", look_id: "<id>", when: { kind: "group", combinator: "and", negate: false, rules: [{ kind: "rule", field: "host", operator: "is_any_of", params: { values: ["chatgpt"] } }] } }; a dim look after 9pm on the phone: when has device is_any_of ["phone"] and hour between { min: 21, max: 23 }. wear_look still sets the look worn everywhere else. move { id, to } changes a rule\'s place in the order. Use remove_look_rule to take one away.', inputSchema: {
    type: 'object',
    properties: {
      rule: { type: 'object', description: '{ id?, label?, when?, look_id, time_zone? }' },
      at: { type: 'integer', description: 'Where in the order the new rule goes; 0 is first' },
      move: { type: 'object', description: '{ id, to }: put an existing rule at a place in the order' },
      by: { type: 'string', description: 'Your name as the person knows you, such as Claude or ChatGPT' },
    },
  }, run: ({ by, ...input }) => call('/looks/set_rule', by && input.rule && !input.rule.by ? { ...input, rule: { ...input.rule, by } } : input) },
  { name: 'remove_look_rule', description: 'Takes one of the person\'s look rules away (id from read_look_rules); screens it covered wear the look worn everywhere else.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'A rule id from read_look_rules' } } }, run: input => call('/looks/remove_rule', input) },
  { name: 'withdraw_look', description: 'Takes one of this person\'s looks off the Marketplace. People who already took it keep their copy.', inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: lookIdField } }, run: input => call('/looks/withdraw', input) },
];

export const lookAnnotations = {
  list_looks: { title: 'List my screen looks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_look: { title: 'Read one screen look', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  wear_look: { title: 'Wear a screen look', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_look: { title: 'Make or change a screen look', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  publish_look: { title: 'Publish a screen look on the Marketplace', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  look_over_time: { title: 'Change my screen look over the day', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_look_rules: { title: 'Read where each screen look applies', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_look_rule: { title: 'Wear a look in one app, on one device or at one time', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_look_rule: { title: 'Take a look rule away', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  withdraw_look: { title: 'Withdraw a screen look from the Marketplace', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};
