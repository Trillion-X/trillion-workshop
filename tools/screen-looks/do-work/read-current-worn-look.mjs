// Reads the current screen look from this person's records and carries the resolved token payload to native screens.
// The run's selected workspace and the app-owned DATA passed in the request are the only sources of the answer.
import operators from '../../formulas/read-data/rule-operators.json' with { type: 'json' };
import { resolveScreenLookPalette, resolveScreenLookButton } from '../read-data/resolve-screen-look-palette.js';
import { deviceLook } from '../read-data/device-look-tokens.js';
import { compileRules, ruleVocabulary } from '../../formulas/do-work/compile-rules.mjs';
import { filterRows } from '../../formulas/do-work/evaluate-binding.mjs';
import { blendLookValues, lookAtTime, readLookPlan } from '../read-data/look-over-time.ts';
import { timeZoneName } from '../read-data/look-time-zone.js';

const WORN = 'screen-look';
const OWN = 'screen-look-own-themes';
const PLAN_KEY = 'screen-look-over-time';
const RULES_KEY = 'where-looks-apply';
const RECORD_PREFIX = 'package::screen-look::published-record::editable-theme::';
const BLENDING_READ_MS = 15 * 60 * 1000;
const AHEAD_MS = 12 * 60 * 60 * 1000;
const AHEAD_STEP_MS = 10 * 60 * 1000;
const AHEAD_BLEND_STEPS = 10;
const vocabulary = ruleVocabulary(operators);

function validLook(value) {
  return value && value.kind === 'screen-look-editable-theme' && typeof value.id === 'string' && value.id.trim()
    && typeof value.name === 'string' && value.name.trim() && Array.isArray(value.tokens) && value.tokens.length > 0;
}

function appDataOf(input) {
  const appData = input?.app_data;
  const looksData = appData?.looks;
  const plan = appData?.look_over_time;
  const rules = appData?.where_looks_apply;
  if (!looksData || typeof looksData !== 'object' || !Array.isArray(looksData.themes)
    || typeof looksData.start_with !== 'string' || !looksData.start_with.trim()) {
    throw new Error('app_data.looks must come from the app owner and include start_with and themes.');
  }
  if (!plan || typeof plan !== 'object' || plan.record_key !== PLAN_KEY || !Array.isArray(plan.anchors)
    || !Array.isArray(plan.presets) || !Number.isInteger(plan.most_points) || plan.most_points < 1
    || !plan.keep_readable || typeof plan.keep_readable.ground !== 'string' || !Number.isFinite(plan.keep_readable.least_contrast)) {
    throw new Error(`app_data.look_over_time must be the app owner's ${PLAN_KEY} settings.`);
  }
  if (!rules || typeof rules !== 'object' || rules.record_key !== RULES_KEY || !Array.isArray(rules.facts)) {
    throw new Error(`app_data.where_looks_apply must be the app owner's ${RULES_KEY} settings.`);
  }
  const appLooks = themesFrom(looksData.themes);
  if (!appLooks.some(look => look.id === looksData.start_with)) {
    throw new Error('app_data.looks.start_with must name one of its app-owned looks.');
  }
  if (!rules.facts.every(fact => fact && typeof fact.id === 'string' && typeof fact.kind === 'string')) {
    throw new Error('app_data.where_looks_apply.facts must name each fact id and kind.');
  }
  return { appLooks, startWith: looksData.start_with, planSettings: plan, ruleSettings: rules };
}

function themesFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map(row => row?.payload ?? row).filter(validLook);
}

function wornId(value, startWith) {
  const row = Array.isArray(value) ? value[0] : null;
  return typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : startWith;
}

function factsAt(now, zone, input) {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'long' });
  const parts = Object.fromEntries(date.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    host: typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null,
    device: typeof input.device === 'string' && input.device.trim() ? input.device.trim() : null,
    device_id: typeof input.device_id === 'string' && input.device_id.trim() ? input.device_id.trim() : null,
    place: typeof input.place === 'string' && input.place.trim() ? input.place.trim() : null,
    hour: Number(parts.hour) % 24,
    weekday: String(parts.weekday).toLowerCase(),
    now: now.getTime(),
  };
}

function nextHourAt(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(now).map(({ type, value }) => [type, value]));
  return now.getTime() + (60 - Number(parts.minute)) * 60_000 - (now.getTime() % 60_000) || now.getTime() + 3_600_000;
}

function ruleResult(value, facts, now, zone, wearableIds, ruleSettings) {
  if (!['host', 'device', 'device_id', 'place'].some(key => facts[key])) return { lookId: null, ruleId: null, next: null };
  const rules = value && Array.isArray(value.rules) ? value.rules.filter(rule => rule && rule.on !== false && typeof rule.look_id === 'string' && wearableIds.has(rule.look_id)) : [];
  let ruleId = null;
  let lookId = null;
  let readsClock = false;
  for (const rule of rules) {
    if (rule.when == null) { ruleId = rule.id ?? null; lookId = rule.look_id; break; }
    const turns = new Set(ruleSettings.facts.filter(fact => fact.turns).map(fact => fact.id));
    const mentionsClock = node => node && typeof node === 'object' && (node.kind === 'rule'
      ? turns.has(node.field)
      : Array.isArray(node.rules) && node.rules.some(mentionsClock));
    readsClock ||= mentionsClock(rule.when);
    const ruleZone = timeZoneName(rule.time_zone) ?? zone;
    const row = factsAt(now, ruleZone, facts);
    const fields = ruleSettings.facts.map(({ id, kind }) => ({ id, kind }));
    const { binding } = compileRules(rule.when, { fields, vocabulary });
    const result = filterRows([row], binding);
    if (result.errorRows) throw new Error(result.firstError ?? 'A saved screen look rule could not be read.');
    if (result.matches.length) { ruleId = rule.id ?? null; lookId = rule.look_id; break; }
  }
  return { lookId, ruleId, next: readsClock ? nextHourAt(now, zone) : null };
}

function responseLook(look, palette) {
  return deviceLook(look, palette, resolveScreenLookButton(look));
}

/** Read the complete account device look payload. `now` is injectable for tests; production uses this host's clock. */
export async function readCurrentWornLook(input = {}, { door, now = () => new Date() } = {}) {
  if (!door?.readWorkspace) throw new Error('The current workspace reader is unavailable.');
  const { appLooks, startWith, planSettings, ruleSettings } = appDataOf(input);
  const zone = input.time_zone === undefined || input.time_zone === null || input.time_zone === '' ? 'UTC' : timeZoneName(input.time_zone);
  if (!zone) throw new Error(`${String(input.time_zone)} is not a time zone; use one like America/Los_Angeles.`);
  const planLabel = `workspace-preference:${planSettings.record_key}`;
  const rulesLabel = `workspace-preference:${ruleSettings.record_key}`;
  const result = await door.readWorkspace([WORN, OWN, planLabel, rulesLabel]);
  const values = result?.records;
  const recordLabels = [WORN, OWN, planLabel, rulesLabel];
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).some(label => !recordLabels.includes(label))) {
    throw new Error('The current workspace reader did not return the exact selected record set.');
  }
  // The selected workspace reader leaves a missing label out of records and preserves a present null, array or object.
  const valueAt = label => Object.hasOwn(values, label) ? values[label] : null;
  const wornRows = valueAt(WORN);
  const ownRows = valueAt(OWN);
  const planRecord = valueAt(planLabel);
  const rulesRecord = valueAt(rulesLabel);
  const mine = themesFrom(ownRows);
  const byId = new Map(mine.map(look => [look.id, look]));
  const looks = [...appLooks.map(look => byId.get(look.id) ?? look), ...mine.filter(look => !appLooks.some(app => app.id === look.id))];
  if (!looks.length) throw new Error('The screen look records were read, but no wearable looks are available in app DATA.');
  const all = new Map(looks.map(look => [look.id, look]));
  const accountLook = wornId(wornRows, startWith);
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('The native look reader clock did not return a valid date.');
  const facts = factsAt(at, zone, input);
  const placed = ruleResult(rulesRecord, facts, at, zone, new Set(all.keys()), ruleSettings);
  const worn = all.get(placed.lookId) ?? all.get(accountLook) ?? looks[0];
  const palettes = new Map(looks.map(look => [look.id, resolveScreenLookPalette(look)]));
  const buttons = new Map(looks.map(look => [look.id, resolveScreenLookButton(look)]));
  const plan = readLookPlan(planRecord, planSettings);
  const movingAt = instant => lookAtTime(plan, instant, zone, planSettings);
  const momentAt = (instant, steps = 0) => {
    const moving = movingAt(instant);
    const [from, to] = moving ? [all.get(moving.from), all.get(moving.to)] : [null, null];
    if (!moving || !from || !to || moving.held?.kind === 'worn' || placed.ruleId) return { moving, key: `worn:${worn.id}` };
    const exact = from === to ? 1 : Math.min(1, Math.max(0, moving.t));
    const t = steps ? Math.round(exact * steps) / steps : exact;
    return { moving, from, to, t, key: t <= 0 ? `look:${from.id}` : t >= 1 ? `look:${to.id}` : `blend:${from.id}:${to.id}:${t}` };
  };
  const lookOf = moment => {
    const { from, to, t } = moment;
    if (!from) return responseLook(worn, palettes.get(worn.id));
    if (t <= 0) return responseLook(from, palettes.get(from.id));
    if (t >= 1) return responseLook(to, palettes.get(to.id));
    const nearer = t < 0.5 ? from : to;
    return deviceLook(nearer, blendLookValues(palettes.get(from.id), palettes.get(to.id), t, planSettings), resolveScreenLookButton(nearer));
  };
  const first = momentAt(at);
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
  const moving = first.moving;
  const blending = moving && !placed.ruleId && moving.held?.kind !== 'worn' && moving.t > 0 && moving.t < 1;
  const planAgain = !moving || placed.ruleId ? null : blending ? Math.min(moving.next.getTime(), at.getTime() + BLENDING_READ_MS) : moving.next.getTime();
  const again = [planAgain, placed.next].filter(value => value !== null).reduce((soonest, value) => soonest === null || value < soonest ? value : soonest, null);
  return {
    worn: worn.id,
    worn_record: { address: `${RECORD_PREFIX}${worn.id}`, payload: worn },
    now: wornNow,
    ahead,
    looks: looks.map(look => responseLook(look, palettes.get(look.id))),
    read_again_at: again === null ? null : new Date(again).toISOString(),
  };
}
