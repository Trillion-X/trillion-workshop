// computer/drive-the-screen.mjs
//
// PURPOSE
//   Lets the person's AIs drive this Mac's screen through the one host that already takes their runs over the live
//   socket (computer/mac-tools.mjs): observe (a screenshot read as text with bounds by computer/observe-visual.mjs, plus
//   the accessibility tree of one running app), locate a target by DATA-described intent, dispatch an action, observe
//   again and say what really changed. Four Workshop tools on placement:your-computer: look, find, drive and actions.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this file names no app, control, coordinate or flow. What an action is, how a screen element becomes
//      comparable, how candidates rank, the limits, the key table and every word are computer/drive-the-screen.json.
//      A new action is a new row there (its steps are the operating system's input primitives that
//      computer/screen-driver.swift runs); nothing here is a list of actions.
//   2. Out of the box the screen is driven with no grant: a limit we impose by default never stops the person's work.
//      The grant gate is a flippable policy (`consent.require_grant` in the DATA, default false). When the person turns
//      it on, it is a floor the call cannot move: reading the screen and each action need an unexpired grant for that
//      exact action (and app, when the grant names apps) in the person's own file, read again at the moment of action.
//      With the gate on, a missing, unreadable, writable-by-others or expired file, and a program that does not
//      answer in time, mean no. Any consent-like key in the call is refused whether the gate is on or off (a model-set
//      skip flag is never honored). The grant tools (grant, revoke, grants) are the person's command line
//      below, never a Workshop tool.
//   3. Mac permission (Accessibility, Screen Recording) is a separate refusal from consent, said in its own words.
//   4. Nothing acts from a stale or remembered location: every drive observes, locates and dispatches in one call, and
//      an observation older than `observation_max_age_ms` is read again. The element is found again by its path at
//      dispatch and refused if it changed.
//   5. Every effect is observed after: `verified` is true only when the caller's expectations hold, false when they do
//      not, and null (with what changed) when none were given. A rehearsal (dry_run) dispatches nothing and says so.
//   7. A secret never reaches the AI: a text input marked `reference` in the DATA may be { saved_login: { login_id, field } }
//      instead of the text. The value is read from the account at the moment of action (the person's own switch for AIs
//      reading that login decides, and the read is listed under the login), typed, and replaced by the DATA's mask in
//      every answer and error of the call. A rehearsal reads nothing.
//   6. Coordinates are in one tagged space (global points, top left of the main display). OCR boxes are converted with
//      the MEASURED image size, and refused when the image's shape does not match the display.
//   8. Working in the background keeps the person's own screen theirs: `background: true` posts input to the driven
//      process itself (never the global stream) and never brings it forward.
//
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactor } from './ask-payload.mjs';
import { withShield } from './capture-shield.mjs';
import { ocrPixels, run } from './observe-visual.mjs';
import { observationVerdict } from './observation-rules.mjs';
import { categorySettings, loadCategoryTable, withCategories } from './observation-categories.mjs';
import { ParkedWrite, writeSettingsFile } from './settings-file.mjs';
import { decisionSettings, refreshControls, requireAllowed, requireHooks, ruleTools } from './run-decision.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const screenSettings = () => JSON.parse(readFileSync(join(HERE, 'drive-the-screen.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
/** A refusal in the words of settings.words[key], carrying the reaction the caller owes it (settings.reactions[key]:
  *  retry, ask_user, use_different_tool or stop), whether the action may have run (settings.outcome_unknown) and, when the refusal knows it, `retry`. */
const refuse = (settings, key, values = {}, status = 403, retry) => Object.assign(new Error(fill(settings.words[key], values)), {
  status, reaction: settings.reactions[key], reaction_said: settings.reaction_classes[settings.reactions[key]], ...(settings.outcome_unknown.includes(key) ? { outcome: 'unknown' } : {}), ...(retry === undefined ? {} : { retry }),
});
/** The stop key as the program is told it: the DATA row without its note. */
const stopKeyOf = settings => { const { _what, ...key } = settings.acting.stop_key ?? { enabled: false }; return key; };
const lower = value => String(value ?? '').toLowerCase();

/** `{a.b}` placeholders filled from values: a whole-string placeholder keeps its type; a key whose value is nothing is dropped. */
export function fillTemplate(node, values) {
  const get = path => path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), values);
  if (typeof node === 'string') {
    const whole = /^\{([\w.]+)\}$/.exec(node);
    return whole ? get(whole[1]) : node.replace(/\{([\w.]+)\}/g, (_, path) => String(get(path) ?? ''));
  }
  if (Array.isArray(node)) return node.map(item => fillTemplate(item, values));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) { const filled = fillTemplate(value, values); if (filled !== undefined) out[key] = filled; }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------------------------- consent (the floor)

const grantsPath = (settings, home) => join(home, settings.consent.file);

/** The grants in force, read fresh. { ok: true, grants } (a missing file is no grants) or { ok: false } (cannot be trusted). */
export function readGrants(settings, home = homedir()) {
  const file = grantsPath(settings, home);
  try {
    if (statSync(file).mode & 0o022) return { ok: false };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value.grants) ? { ok: true, grants: value.grants } : { ok: false };
  } catch (error) { return error?.code === 'ENOENT' ? { ok: true, grants: [] } : { ok: false }; }
}

const identitiesOf = app => [app?.name, app?.bundle_id].filter(Boolean).map(lower);

/** Whether a grant covers `action` on `app` at `now`: this exact action, unexpired, and the app when the grant names apps. */
export const covers = (grant, action, app, now) => Array.isArray(grant?.actions) && grant.actions.includes(action)
  && Date.parse(grant.expires_at) > now
  && (!grant.apps?.length || grant.apps.some(name => identitiesOf(app).includes(lower(name))));

function writeGrants(settings, home, grants) {
  const file = grantsPath(settings, home);
  // A grants file that cannot be understood is never replaced by an empty one (computer/settings-file.mjs).
  try { writeSettingsFile(file, { grants }, { accept: value => Array.isArray(value?.grants) }); }
  catch (error) { throw error instanceof ParkedWrite ? refuse(settings, 'parked', { file, why: error.why }, 409) : error; }
}

// The decision table (computer/run-decision.json) a driver judges every action by, before any grant is looked at.
let decisionTable = null;
const decisionOf = settings => settings.decision ?? (decisionTable ??= decisionSettings());

/** The floor. With `consume`, a grant that counts its uses (`uses`: once is 1) is spent by this action and gone at zero. */
function requireConsent(settings, home, action, app, now, { consume = false } = {}) {
  requireAllowed(decisionOf(settings), home, { action, app: identitiesOf(app) });
  if (!settings.consent.require_grant) return;
  const state = readGrants(settings, home);
  if (!state.ok) throw refuse(settings, 'unreadable_grants', {});
  const found = state.grants.find(grant => covers(grant, action, app, now));
  if (!found) throw refuse(settings, 'no_grant', { action, app: app?.name ? ` in ${app.name}` : '' });
  if (consume && Number.isInteger(found.uses)) {
    found.uses -= 1;
    writeGrants(settings, home, state.grants.filter(grant => grant !== found || grant.uses > 0));
  }
}

/** A grant the person made, whatever the gate: the guards below ask for these even when `require_grant` is off. */
const grantedFor = (settings, home, action, app, now) => {
  const state = readGrants(settings, home);
  return state.ok && state.grants.some(grant => covers(grant, action, app, now));
};

// ------------------------------------------------------------------------------------------- guards (opt-in rows)

const sessionOf = input => (typeof input?.session === 'string' && input.session.trim() ? input.session.trim().slice(0, 100) : 'default');
const taintPath = (settings, home) => join(home, settings.guards.taint.file);

function readTaint(settings, home, at) {
  try {
    const sessions = JSON.parse(readFileSync(taintPath(settings, home), 'utf8')).sessions ?? {};
    const keep = at - settings.guards.taint.window_minutes * 60_000;
    return Object.fromEntries(Object.entries(sessions).map(([id, kinds]) => [id, Object.fromEntries(Object.entries(kinds).filter(([, when]) => Date.parse(when) > keep))]));
  } catch { return {}; }
}

/** Records what a session has read, when the taint rows are on. */
function markTaint(settings, home, session, kinds, at) {
  if (!settings.guards.taint.enabled || !kinds.length) return;
  const sessions = readTaint(settings, home, at);
  sessions[session] = { ...(sessions[session] ?? {}), ...Object.fromEntries(kinds.map(kind => [kind, new Date(at).toISOString()])) };
  const file = taintPath(settings, home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.next`, JSON.stringify({ sessions }), { mode: 0o600 });
  renameSync(`${file}.next`, file);
}

/** Refuses an action a session could use to send on what it read, when the person turned the rows on. */
function requireTaintClear(settings, home, action, session, app, at) {
  const rules = settings.guards.taint;
  if (!rules.enabled) return;
  const held = Object.keys(readTaint(settings, home, at)[session] ?? {});
  const hit = rules.refuse_when.find(row => row.actions.includes(action) && row.taints.every(kind => held.includes(kind)));
  if (hit && !grantedFor(settings, home, rules.grant_action, app, at)) throw refuse(settings, 'tainted_refused', { action, grant: rules.grant_action });
}

/** The off-limits class an app belongs to, or null: only while settings.off_limits.enabled (a flippable policy, off by
 *  default), by any identity the app has against a class's bundle ids and names. */
export function offLimitsClass(settings, app) {
  if (!settings.off_limits.enabled) return null;
  const identities = identitiesOf(app);
  return settings.off_limits.classes.find(row => [...(row.bundle_ids ?? []), ...(row.names ?? [])].some(name => identities.includes(lower(name)))) ?? null;
}

function rejectCarriedConsent(settings, input) {
  const found = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { if (settings.consent.refuse_input_keys.includes(key)) found.add(key); walk(item); }
  };
  walk(input);
  if (found.size) throw refuse(settings, 'carried_consent', { keys: [...found].join(', ') });
}

/** The person's own commands: grant, revoke, list. These write the file the floor reads and are not Workshop tools. */
export function grantTools(settings = screenSettings(), { home = homedir(), now = () => Date.now() } = {}) {
  const file = grantsPath(settings, home);
  const save = grants => writeGrants(settings, home, grants);
  const current = () => { const state = readGrants(settings, home); return state.ok ? state.grants.filter(grant => Date.parse(grant.expires_at) > now()) : []; };
  const known = [settings.consent.read_action, ...Object.keys(settings.actions), settings.guards.credential_surface.grant_action, settings.guards.taint.grant_action];
  return {
    grant({ actions, apps = [], minutes = settings.consent.default_minutes, uses }) {
      const chosen = [...new Set(actions ?? [])];
      if (!chosen.length || !chosen.every(name => known.includes(name)) || !(minutes > 0) || (uses !== undefined && !(Number.isInteger(uses) && uses > 0))) throw refuse(settings, 'grant_needs', {}, 400);
      const capped = Math.min(minutes, settings.consent.max_minutes);
      const at = now();
      // The id carries a random part: two grants made in the same millisecond shared `grant-<ms>`, so finding, spending or revoking one reached the other.
      const grant = { id: `grant-${at}-${randomUUID().slice(0, 8)}`, actions: chosen, ...(apps.length ? { apps } : {}), ...(uses ? { uses } : {}), granted_at: new Date(at).toISOString(), expires_at: new Date(at + capped * 60_000).toISOString() };
      save([...current(), grant]);
      const remember = ruleTools(decisionOf(settings), { home });
      for (const action of chosen) for (const app of apps.length ? apps : [null]) remember.approved({ action, app, at });
      const words = uses === 1 ? settings.words.grant_made_once : uses ? settings.words.grant_made_times : settings.words.grant_made;
      const what = chosen.map(name => settings.actions[name]?.what ?? name).join(' ');
      return { grant, said: fill(words, { actions: chosen.join(', '), apps: apps.length ? ` in ${apps.join(', ')}` : '', until: grant.expires_at, uses }),
        sentence: fill(settings.words.grant_describes, { what, apps: apps.length ? ` In ${apps.join(', ')} only.` : '' }) };
    },
    revoke({ id } = {}) {
      const all = current();
      const kept = id ? all.filter(grant => grant.id !== id) : [];
      save(kept);
      return { revoked: all.length - kept.length, said: fill(settings.words.grant_revoked, { count: all.length - kept.length }) };
    },
    grants() { const all = current(); return { grants: all, said: all.length ? '' : settings.words.grant_none }; },
    known,
  };
}

// --------------------------------------------------------------------------------------------- elements and matching

const normalizeField = (settings, field, value) => (settings.elements.normalized_fields.includes(field) && typeof value === 'string'
  ? lower(value.replace(new RegExp(settings.elements.role_strip), '')) : value);
const firstOf = (raw, keys) => keys.map(key => raw[key]).find((value, index) => typeof value === 'string' && (value.trim() || keys[index] === 'value'));

/** One source's raw row → a comparable element { source, fields, text, frame, center, enabled, actions, ref, raw }. */
export function elementOf(settings, source, raw, extra = {}) {
  const spec = settings.elements[source];
  const fields = { ...(spec.static ?? {}) };
  for (const [name, keys] of Object.entries(spec.fields)) { const value = firstOf(raw, keys); if (value !== undefined) fields[name] = value; }
  for (const name of settings.elements.normalized_fields) if (fields[name] !== undefined) fields[name] = normalizeField(settings, name, fields[name]);
  fields.text = spec.text_from.map(key => raw[key]).filter(value => typeof value === 'string' && value).join(' ');
  const frame = raw.frame;
  const sized = frame && frame.width > 0 && frame.height > 0;
  return { source, fields, frame: sized ? frame : undefined,
    center: sized ? { x: Math.round((frame.x + frame.width / 2) * 10) / 10, y: Math.round((frame.y + frame.height / 2) * 10) / 10 } : undefined,
    enabled: raw.enabled, actions: raw.actions, ref: raw.path ? { path: raw.path } : undefined, raw, ...extra };
}

/** The best text-match grade of a matcher against a value: 0 no match, 1 contains, 2 starts with, 3 equals; a regex or `equals`/`contains` matcher grades 3. */
function grade(spec, value) {
  if (value === undefined || value === null) return 0;
  const have = lower(value);
  if (typeof spec === 'string') { const want = lower(spec); return have === want ? 3 : have.startsWith(want) ? 2 : have.includes(want) ? 1 : 0; }
  if (spec && typeof spec === 'object') {
    if (spec.equals !== undefined) return have === lower(spec.equals) ? 3 : 0;
    if (spec.contains !== undefined) return have.includes(lower(spec.contains)) ? 3 : 0;
    if (spec.starts_with !== undefined) return have.startsWith(lower(spec.starts_with)) ? 3 : 0;
    if (spec.regex !== undefined) { try { return new RegExp(spec.regex, 'i').test(String(value)) ? 3 : 0; } catch { return 0; } }
  }
  return 0;
}

/** The caller's description of a target: a string (its label) or { match: { field: matcher }, source?, nth? }. */
export function targetSpec(target) {
  if (typeof target === 'string') return { match: { label: target } };
  if (target && typeof target === 'object' && target.match && typeof target.match === 'object') return target;
  return null;
}

const insideADisplay = (center, displays) => !center || displays.some(d => center.x >= d.x && center.x <= d.x + d.width && center.y >= d.y && center.y <= d.y + d.height);

/** Every element the target matches, ranked by the settings' `rank` rows. needs/sources come from the action's target row. */
export function locate(settings, observation, target, { needs = [], sources = null } = {}) {
  const spec = targetSpec(target);
  if (!spec) return [];
  const wanted = spec.source ? [spec.source] : sources;
  const order = settings.elements.source_order;
  const scored = [];
  for (const element of observation.elements) {
    if (wanted && !wanted.includes(element.source)) continue;
    if (needs.some(name => element[name] === undefined && element.center?.[name] === undefined)) continue;
    if (!insideADisplay(element.center, observation.displays)) continue;
    let score = 0;
    for (const [field, matcher] of Object.entries(spec.match)) {
      const g = grade(typeof matcher === 'string' ? normalizeField(settings, field, matcher) : matcher, element.fields[field]);
      if (!g) { score = 0; break; }
      score += g;
    }
    if (!score) continue;
    const frame = element.frame;
    scored.push({ element, ranked: { score, source_rank: order.indexOf(element.source), disabled: element.enabled === false ? 1 : 0,
      area: frame ? frame.width * frame.height : Infinity, y: frame?.y ?? Infinity, x: frame?.x ?? Infinity } });
  }
  scored.sort((a, b) => {
    for (const { field, direction } of settings.elements.rank) {
      const difference = a.ranked[field] - b.ranked[field];
      if (difference) return direction === 'desc' ? -difference : difference;
    }
    return 0;
  });
  return scored.map(row => ({ ...row.element, score: row.ranked.score }));
}

/** What a located element offers a step: the point, the path, the raw fields, the app. */
const targetValues = (element, app) => ({ source: element.source, label: element.fields.label, role: element.fields.role, ...(element.center ?? {}),
  ...(element.ref ? { ref: element.ref } : {}), raw: element.raw, app });

const brief = element => ({ id: element.id, source: element.source, role: element.fields.role, label: element.fields.label ?? element.fields.text,
  ...(element.center ? { x: element.center.x, y: element.center.y, width: element.frame.width, height: element.frame.height } : {}),
  ...(element.enabled === false ? { enabled: false } : {}), ...(element.actions ? { actions: element.actions } : {}), ...(element.score ? { score: element.score } : {}) });

/** What changed between two observations, by element identity (source, role, label, value, rounded frame). */
export function diffElements(before, after, samples) {
  const key = element => [element.source, element.fields.role, element.fields.label, element.raw.value, ...(element.frame ? [element.frame.x, element.frame.y, element.frame.width, element.frame.height].map(Math.round) : [])].join('|');
  const was = new Map(before.map(element => [key(element), element]));
  const is = new Map(after.map(element => [key(element), element]));
  const added = [...is].filter(([k]) => !was.has(k)).map(([, element]) => element);
  const removed = [...was].filter(([k]) => !is.has(k)).map(([, element]) => element);
  return { changed: added.length + removed.length > 0, added: added.length, removed: removed.length,
    added_sample: added.slice(0, samples).map(brief), removed_sample: removed.slice(0, samples).map(brief) };
}

/** One expectation against the screen after: { target, min?, max? } counts matches (default at least one); { changed } needs the diff. */
export function checkExpectation(settings, expectation, observation, diff) {
  if (expectation && typeof expectation === 'object' && typeof expectation.changed === 'boolean') return { expectation, met: diff.changed === expectation.changed, seen: { changed: diff.changed } };
  const count = locate(settings, observation, expectation?.target).length;
  const min = Number.isFinite(expectation?.min) ? expectation.min : (Number.isFinite(expectation?.max) ? 0 : 1);
  const max = Number.isFinite(expectation?.max) ? expectation.max : Infinity;
  return { expectation, met: count >= min && count <= max, seen: { count } };
}

/** The proposed plan of a rehearsal: one sentence per event, from the settings' `plan.lines` (a value with no field reads as empty). */
export const planOf = (settings, events) => events.map(event => fill(settings.plan.lines[event.event] ?? settings.plan.other, { ...event, keys: Array.isArray(event.keys) ? event.keys.join('+') : event.keys,
  modifiers: Array.isArray(event.modifiers) ? event.modifiers.join('+') : event.modifiers }));

// ------------------------------------------------------------------------------------------------------ input types

/** A key combination such as cmd+shift+s → { codes, modifiers } through the settings' key table. */
export function chordOf(settings, text) {
  const parts = String(text ?? '').split(/\s*\+\s*/).filter(Boolean).map(lower);
  const key = parts.pop();
  const modifiers = parts.map(name => settings.keys.modifiers[name]);
  if (key === undefined || modifiers.includes(undefined) || !Object.hasOwn(settings.keys.codes, key)) {
    const bad = key === undefined || Object.hasOwn(settings.keys.codes, key) ? parts[modifiers.indexOf(undefined)] : key;
    throw refuse(settings, 'key_unknown', { key: bad ?? text }, 400);
  }
  return { codes: [settings.keys.codes[key]], modifiers: [...new Set(modifiers)] };
}

const typed = {
  string: value => (typeof value === 'string' ? value : undefined),
  number: value => (Number.isFinite(value) ? value : undefined),
  integer: value => (Number.isFinite(value) ? Math.round(value) : undefined),
};

// ------------------------------------------------------------------------------------------------------------ secrets

const objectLike = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A reference checked and shaped, nothing read: { kind, row, args, wanted } from { saved_login: { login_id, field } }. */
export function checkedReference(settings, given) {
  const rows = settings.secrets.references;
  const kinds = objectLike(given) ? Object.keys(given) : [];
  if (kinds.length !== 1 || !Object.hasOwn(rows, kinds[0])) {
    const first = Object.keys(rows)[0];
    throw kinds.length === 1 ? refuse(settings, 'secret_unknown', { reference: kinds[0], known: Object.keys(rows).join(', ') }, 400)
      : refuse(settings, 'secret_shape', { example: `{ ${first}: { ${[...Object.keys(rows[first].args), rows[first].pick].join(', ')} } }` }, 400);
  }
  const kind = kinds[0], row = rows[kind], named = given[kind];
  const args = {};
  for (const [name, type] of Object.entries(row.args)) {
    if (!objectLike(named) || typeof named[name] !== type) throw refuse(settings, 'bad_input', { name: `${kind}.${name}`, type }, 400);
    args[name] = named[name];
  }
  const wanted = named[row.pick];
  if (typeof wanted !== 'string' || !wanted) throw refuse(settings, 'bad_input', { name: `${kind}.${row.pick}`, type: 'string' }, 400);
  return { kind, row, args, wanted };
}

/** The value a checked reference names, read from the account at this moment with the key this Mac holds. */
export async function secretFromReference(settings, reference, context, call) {
  const { row, args, wanted } = reference;
  let answer;
  try { answer = await call(row.tool, args, context); }
  catch (error) { throw refuse(settings, 'secret_refused', { error: String(error?.message ?? error).slice(0, 200) }, 403); }
  const also = Object.hasOwn(row.also ?? {}, lower(wanted)) ? answer?.[row.also[lower(wanted)]] : undefined;
  const listed = (Array.isArray(answer?.[row.list]) ? answer[row.list] : []).find(item => lower(item?.[row.name]) === lower(wanted))?.[row.value];
  const value = typeof also === 'string' && also ? also : typeof listed === 'string' && listed ? listed : undefined;
  if (value === undefined) throw refuse(settings, 'secret_missing', { pick: row.pick, name: wanted }, 404);
  return value;
}

/** The account's tool, called with the key this Mac holds (the same door computer/mac-tools.mjs accountFilesDoor reads files through). */
const callAccountTool = async (name, args, context) => {
  if (typeof context?.origin !== 'string' || typeof context?.key !== 'string' || !context.key) throw new Error('this Mac holds no account key');
  const { toolCaller } = await import('./keep-drive-files.mjs');
  return toolCaller(context.origin, context.key)(name, args);
};

/** `value` with every secret replaced by the mask, the longest first so one that holds another is masked whole. */
export function masked(value, secrets, mask) {
  if (!secrets.length) return value;
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  const walk = node => {
    if (typeof node === 'string') return ordered.reduce((text, secret) => text.split(secret).join(mask), node);
    if (Array.isArray(node)) return node.map(walk);
    if (objectLike(node)) return Object.fromEntries(Object.entries(node).map(([key, each]) => [key, walk(each)]));
    return node;
  };
  return walk(value);
}

// ------------------------------------------------------------------------------------------------------- the driver

/** The tools, over the programs that touch the Mac, so tests hold a pretend one. */
export function makeScreenDriver({ settings = screenSettings(), home = homedir(), now = () => Date.now(),
  program = request => run(settings.driver.program, [join(HERE, settings.driver.script)], { input: JSON.stringify(request), timeout: settings.limits.program_timeout_ms }).then(value => JSON.parse(value)),
  capture = async () => {
    const folder = await mkdtemp(join(tmpdir(), 'trillion-screen-'));
    try {
      const file = join(folder, 'screen.jpg');
      await withShield(() => run(settings.capture.program, settings.capture.args.map(arg => arg.replace('{file}', file)), { timeout: settings.limits.program_timeout_ms }));
      return await readFile(file);
    } finally { await rm(folder, { recursive: true, force: true }); }
  },
  ocr = ocrPixels, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), readSecret = callAccountTool, parent = () => process.ppid } = {}) {
  const limits = settings.limits;

  // One program answer, or a refusal: a program that fails, does not answer or answers nonsense is never read as allowed.
  const ask = async request => {
    try { return await program(request); }
    catch (error) { throw refuse(settings, 'program_failed', { error: String(error?.message ?? error).slice(0, 200) }, 503); }
  };

  const ready = (readiness, sources) => {
    // A locked screen, or a host the app no longer owns (its parent is launchd), is its own typed refusal, before any Mac permission is asked about.
    if (readiness?.screen_locked === true) throw refuse(settings, 'screen_locked', {}, 409);
    if (settings.acting.refuse_under_launchd === true && parent() === 1) throw refuse(settings, 'host_under_launchd', {}, 409);
    const needed = [...new Set([...settings.elements.always_permissions, ...sources.map(source => settings.elements.source_permissions[source]).filter(Boolean)])];
    const missing = needed.find(name => readiness?.[name] !== true);
    // A typed refusal: callers branch on `code` and say which Mac permission by `permission` (the readiness key), never on the words.
    if (missing) throw Object.assign(refuse(settings, 'not_ready', { what: settings.readiness[missing] }, 409, false), { code: settings.permission_code, permission: missing });
  };

  /** Who is on the screen, without reading it: consent is judged against this app. */
  const factsOf = async app => {
    const facts = await ask({ command: 'read', ...(app ? { app } : {}), max_nodes: 0 });
    if (!facts.app?.pid) throw refuse(settings, 'no_app', { app: app ?? 'the front app' }, 404);
    return { app: facts.app, frontmost: facts.frontmost, readiness: facts.readiness, displays: facts.displays };
  };

  /** One observation of one app (by pid): consent, readiness, the tree, the pixels read as text. */
  async function observe({ facts, sources = settings.elements.source_order, action = settings.consent.read_action, session = 'default' }) {
    await refreshControls(decisionOf(settings), { home });
    const observed_at = now();
    requireConsent(settings, home, action, facts.app, now());
    const verdict = observationVerdict(withCategories(settings.observation, loadCategoryTable(categorySettings(), home), categorySettings().modes), { identities: identitiesOf(facts.app) });
    if (!verdict.observe) throw refuse(settings, 'not_observed', { app: facts.app.name ?? facts.app.bundle_id, why: verdict.why }, 403);
    await requireHooks(decisionOf(settings), home, { action, app: identitiesOf(facts.app) });
    ready(facts.readiness, sources);
    const notes = [];
    const elements = [];
    let truncated = false;
    let image;
    // The tree is always read: it names the app's windows, which bound the text read from the pixels.
    const full = await ask({ command: 'read', pid: facts.app.pid, max_nodes: limits.max_nodes, max_depth: limits.max_depth });
    if (full.app?.pid !== facts.app.pid) throw refuse(settings, 'no_app', { app: facts.app.name }, 404);
    facts = { ...facts, app: full.app, frontmost: full.frontmost, readiness: full.readiness, displays: full.displays };
    ready(facts.readiness, sources);
    const tree = (full.elements ?? []).map((raw, index) => elementOf(settings, 'ax', raw, { id: `ax${index + 1}` }));
    truncated = full.truncated === true;
    if (sources.includes('ax')) elements.push(...tree);
    if (sources.includes('ocr')) {
      const seen = await ocr(await capture());
      const display = facts.displays.find(d => d.main) ?? facts.displays[0];
      const aspect = (seen.width / seen.height) / (display.width / display.height);
      image = { width: seen.width, height: seen.height, scale: Math.round((seen.width / display.width) * 100) / 100, space: settings.coordinates.space };
      const windows = settings.elements.ocr.within_app_windows ? tree.filter(element => element.ref?.path.length === 1 && element.frame) : null;
      if (Math.abs(aspect - 1) > settings.capture.aspect_tolerance) {
        notes.push(fill(settings.words.ocr_shape, { image: `${seen.width}x${seen.height}`, display: `${display.width}x${display.height}` }));
      } else {
        for (const line of seen.lines ?? []) {
          if (!(line.confidence >= settings.elements.ocr.min_confidence) || !line.text.trim()) continue;
          const frame = { x: display.x + line.x * display.width, y: display.y + (1 - line.y - line.height) * display.height, width: line.width * display.width, height: line.height * display.height };
          const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
          if (windows && !windows.some(w => centre.x >= w.frame.x && centre.x <= w.frame.x + w.frame.width && centre.y >= w.frame.y && centre.y <= w.frame.y + w.frame.height)) continue;
          elements.push(elementOf(settings, 'ocr', { text: line.text.trim(), confidence: line.confidence, frame }, { id: `ocr${elements.length + 1}` }));
        }
        if (windows) notes.push(settings.words.ocr_within_windows);
      }
    }
    const observed = { observed_at, app: facts.app, frontmost: facts.frontmost, readiness: facts.readiness, displays: facts.displays, image, elements, truncated, notes, sources };
    const guards = settings.guards;
    observed.credential_surface = guards.credential_surface.match.some(spec => locate(settings, observed, spec).length > 0);
    const privateApps = guards.taint.private_apps.map(lower);
    markTaint(settings, home, session, [guards.taint.sources.read, ...(identitiesOf(facts.app).some(name => privateApps.includes(name)) ? [guards.taint.sources.private] : [])], now());
    return observed;
  }

  const summary = observation => ({ observed_at: new Date(observation.observed_at).toISOString(), app: observation.app, frontmost: observation.frontmost,
    displays: observation.displays, ...(observation.image ? { image: observation.image } : {}), coordinates: settings.coordinates.space,
    counts: { ax: observation.elements.filter(e => e.source === 'ax').length, ocr: observation.elements.filter(e => e.source === 'ocr').length },
    truncated: observation.truncated, ...(observation.credential_surface ? { credential_surface: settings.words.credential_surface } : {}),
    ...(settings.guards.untrusted_notice ? { content_notice: settings.words.untrusted_content } : {}), ...(observation.notes.length ? { notes: observation.notes } : {}) });

  // A drive reports each side of the change briefly; the full list is what look is for.
  const slim = ({ observed_at, app, frontmost, counts, truncated, notes }) => ({ observed_at, app, frontmost,
    foreground_matches_app: Boolean(app?.pid && app.pid === frontmost?.pid), counts, truncated, ...(notes ? { notes } : {}) });

  const sourcesOf = input => {
    const asked = input.sources ?? settings.elements.source_order;
    if (!Array.isArray(asked) || !asked.length || !asked.every(name => settings.elements.source_order.includes(name))) throw refuse(settings, 'bad_input', { name: 'sources', type: `a list of ${settings.elements.source_order.join(', ')}` }, 400);
    return asked;
  };

  // One acting session at a time across every AI that calls this host: a drive waits for the one before it to finish,
  // so two runs never interleave input on the same screen (settings.acting.one_at_a_time).
  let acting = Promise.resolve();
  const oneAtATime = work => {
    if (!settings.acting.one_at_a_time) return work();
    const turn = acting.then(work, work);
    acting = turn.then(() => undefined, () => undefined);
    return turn;
  };

  // A refusal says whether the same call may be tried again, so an AI never loops on a no from the person or the rules.
  const withRetry = tool => async (...args) => {
    try { return await tool(...args); }
    catch (error) {
      if (error?.status && error.retry === undefined) error.retry = settings.retry.may.includes(error.status);
      throw error;
    }
  };

  /** One drive; every secret it reads is pushed to `secrets` so the caller can mask it. */
  const driveOnce = async (input, account, secrets) => {
    rejectCarriedConsent(settings, input);
    const action = Object.hasOwn(settings.actions, input.action) ? settings.actions[input.action] : null;
    if (!action) throw refuse(settings, 'unknown_action', { action: input.action }, 404);
    const allowedKeys = new Set(['action', 'target', 'app', 'expect', 'dry_run', 'session', 'background', ...Object.keys(action.inputs ?? {})]);
    const extra = Object.keys(input).find(name => !allowedKeys.has(name));
    if (extra) throw refuse(settings, 'takes_not', { action: input.action, name: extra }, 400);
    if (input.background !== undefined && typeof input.background !== 'boolean') throw refuse(settings, 'bad_input', { name: 'background', type: 'true or false' }, 400);
    const inBackground = input.background === true;

    // Inputs, each in its type; a target input is located below.
    const values = {};
    const references = {};
    const toLocate = [];
    for (const [name, spec] of Object.entries({ ...(action.target ? { target: { type: 'target', required: action.target.required } } : {}), ...(action.inputs ?? {}) })) {
      const given = input[name];
      if (given === undefined || given === null) {
        if (spec.required) throw refuse(settings, 'needs_input', { action: input.action, name }, 400);
        continue;
      }
      if (spec.type === 'target') {
        if (!targetSpec(given)) throw refuse(settings, 'bad_input', { name, type: 'a label or { match }' }, 400);
        toLocate.push(name);
      } else if (spec.type === 'chord') values[name] = chordOf(settings, given);
      else if (spec.reference === true && objectLike(given)) {
        // Checked now, read only at the moment of action (below); until then the steps and the answer hold a stand-in.
        references[name] = checkedReference(settings, given);
        values[name] = settings.secrets.rehearsal_stand_in;
      } else {
        const parsed = typed[spec.type]?.(given);
        if (parsed === undefined) throw refuse(settings, 'bad_input', { name, type: spec.type }, 400);
        values[name] = parsed;
      }
    }
    const expectations = input.expect === undefined ? [] : [].concat(input.expect);

    const sources = action.target?.sources ?? settings.elements.source_order;
    const facts = await factsOf(input.app);
    const session = sessionOf(input);
    let before = await observe({ facts, sources, session });
    if (now() - before.observed_at > limits.observation_max_age_ms) before = await observe({ facts, sources, session });

    const located = {};
    const said = [];
    for (const name of toLocate) {
      const found = locate(settings, before, input[name], { needs: action.target?.needs ?? [], sources: action.target?.sources ?? null });
      if (!found.length) {
        throw action.target?.sources ? refuse(settings, 'no_target_source', { action: input.action, sources: action.target.sources.join(' or ') }, 404) : refuse(settings, 'no_target', { target: JSON.stringify(input[name]) }, 404);
      }
      const nth = Number.isInteger(input[name]?.nth) ? input[name].nth : 0;
      if (nth < 0 || nth >= found.length) throw refuse(settings, 'bad_input', { name: `${name}.nth`, type: `an index from 0 to ${found.length - 1}` }, 400);
      if (settings.abstain?.enabled && input[name]?.nth === undefined && found.length > 1 && found[0].score - found[1].score < settings.abstain.margin) {
        throw refuse(settings, 'ambiguous_refusal', { count: found.length, target: JSON.stringify(input[name]), last: found.length - 1 }, 409, false);
      }
      const chosen = found[nth];
      located[name] = { ...targetValues(chosen, facts.app), brief: brief(chosen), matches: found.length };
      if (found.length > 1 && nth === 0) said.push(fill(settings.words.ambiguous_note, { count: found.length }));
    }

    const stepsFor = filled => {
      const steps = action.steps.filter(step => !step.when || fillTemplate(`{${step.when}}`, filled) !== undefined)
        .filter(step => !inBackground || !settings.background.skip_events.includes(step.event))
        .map(({ when: _when, ...step }) => fillTemplate(step, filled))
        .map(step => (step.event === 'caption' && step.ms === undefined ? { ...step, ms: limits.caption_ms } : step));
      // The visible caption before an action that has a located point, when the person has turned it on.
      const at = located.target;
      if (settings.narration.each_action && at?.x !== undefined && !steps.some(step => step.event === 'caption')) {
        steps.unshift({ event: 'caption', x: at.x, y: at.y, text: fill(settings.words.narration, { action: input.action, label: at.label ?? '' }), ms: limits.caption_ms });
      }
      return steps;
    };
    const events = stepsFor({ ...values, ...located });
    if (events.length > limits.max_events) throw refuse(settings, 'too_many_steps', { action: input.action, count: events.length, limit: limits.max_events }, 400);
    const found = { action: input.action, observed_before: { ...slim(summary(before)), ...(before.credential_surface ? { credential_surface: settings.words.credential_surface } : {}) }, targets: Object.fromEntries(Object.entries(located).map(([name, row]) => [name, { ...row.brief, matches: row.matches }])), events };
    if (input.dry_run === true) return { ...found, plan: planOf(settings, events), dispatched: false, verified: null, said: fill(settings.words.dry_run, { action: input.action }) };

    // The floor again at the moment of action, from the person's file as it is now.
    requireConsent(settings, home, input.action, facts.app, now(), { consume: true });
    await requireHooks(decisionOf(settings), home, { action: input.action, app: identitiesOf(facts.app) });
    if (action.writes && before.credential_surface && settings.guards.credential_surface.refuse_writes
      && !grantedFor(settings, home, settings.guards.credential_surface.grant_action, facts.app, now())) {
      throw refuse(settings, 'credential_refused', { action: input.action });
    }
    requireTaintClear(settings, home, input.action, session, facts.app, now());
    const age = now() - before.observed_at;
    if (age > limits.observation_max_age_ms) throw refuse(settings, 'stale', { seconds: Math.round(age / 1000), limit: Math.round(limits.observation_max_age_ms / 1000) }, 409);
    ready(facts.readiness, ['ax']);

    const blocked = offLimitsClass(settings, facts.app);
    if (blocked) throw refuse(settings, 'off_limits', { app: facts.app.name ?? facts.app.bundle_id, what: blocked.what }, 403);

    // A secret is read here, after every check above has passed, and only into the steps the program is given.
    const secretValues = {};
    for (const [name, reference] of Object.entries(references)) { secretValues[name] = await secretFromReference(settings, reference, account, readSecret); secrets.push(secretValues[name]); }
    const dispatched = await ask({ command: 'act', pid: before.app.pid, failsafe: settings.failsafe, events: Object.keys(secretValues).length ? stepsFor({ ...values, ...secretValues, ...located }) : events, stop: stopKeyOf(settings),
      ...(inBackground ? { deliver: settings.background.deliver } : {}) });
    // The program may decline the whole drive (a screen that locked since the read, an owner that is gone): nothing was posted.
    if (dispatched.refused) throw refuse(settings, dispatched.refused, {}, 409);
    // A button the drive pressed and had not let go of when it ended was let go by the program: say so, ended early or not.
    const letGo = Array.isArray(dispatched.released) && dispatched.released.length ? fill(settings.words.released_buttons, { buttons: dispatched.released.join(', ') }) : '';
    const withLetGo = error => Object.assign(error, { message: letGo ? `${error.message} ${letGo}` : error.message });
    if (dispatched.stopped_by_person === true) throw withLetGo(refuse(settings, 'stopped_by_person', {}, 499));
    const failed = (dispatched.events ?? []).find(row => !row.ok);
    if (failed || dispatched.completed !== true) {
      throw withLetGo(refuse(settings, 'dispatch_failed', { action: input.action, event: failed?.event ?? 'the first step', detail: failed?.detail ?? 'no answer' }, 502));
    }

    const keyed = dispatched.secure_input?.enabled === true;
    if (letGo) said.push(letGo);
    if (keyed) {
      const holder = dispatched.secure_input.app?.name;
      said.push(fill(settings.words.secure_input, { holder: holder ? fill(settings.words.secure_input_holder, { app: holder }) : '' }));
    }

    if (action.settle) await wait(limits.settle_ms);
    const after = await observe({ facts, sources, session });
    const diff = diffElements(before.elements, after.elements, limits.diff_samples);
    const checks = expectations.map(expectation => checkExpectation(settings, expectation, after, diff));
    const verified = checks.length ? checks.every(check => check.met) : null;
    return { ...found, dispatched: true, ...(inBackground ? { background: true } : {}), results: dispatched.events, observed_after: slim(summary(after)), effect: diff,
      ...(checks.length ? { checks } : {}), verified,
      said: [fill(verified === null ? settings.words.unchecked : verified ? settings.words.verified : settings.words.not_verified, { action: input.action }), ...said].join(' ') };
  };

  const driver = {
    /** What is on the screen: the app, the displays, the elements (bounded), in one tagged space. */
    async look(input = {}) {
      rejectCarriedConsent(settings, input);
      const observation = await observe({ facts: await factsOf(input.app), sources: sourcesOf(input), session: sessionOf(input) });
      const ordered = observation.elements.slice().sort((a, b) => (a.frame?.y ?? 1e9) - (b.frame?.y ?? 1e9) || (a.frame?.x ?? 1e9) - (b.frame?.x ?? 1e9));
      // What the AI reads leaves this Mac: the person's redaction (computer/ask-payload.mjs, off until they turn it on) is applied here.
      return redactor(undefined, home)({ ...summary(observation), elements: ordered.slice(0, limits.max_elements).map(brief), shown: Math.min(ordered.length, limits.max_elements) });
    },

    /** Where a described target is on the screen now: ranked candidates, nothing done. */
    async find(input = {}) {
      rejectCarriedConsent(settings, input);
      if (!targetSpec(input.target)) throw refuse(settings, 'needs_input', { action: 'find', name: 'a target (a label, or { match: { field: matcher } })' }, 400);
      const observation = await observe({ facts: await factsOf(input.app), sources: sourcesOf(input), session: sessionOf(input) });
      const found = locate(settings, observation, input.target, { sources: input.sources });
      return { ...summary(observation), matches: found.length, candidates: found.slice(0, limits.max_candidates).map(brief),
        ...(found.length ? {} : { said: fill(settings.words.no_target, { target: JSON.stringify(input.target) }) }) };
    },

    /** The action set this Mac keeps, from DATA. */
    actions() {
      return { actions: Object.entries(settings.actions).map(([id, row]) => ({ id, what: row.what, target: row.target?.required ? 'required' : 'optional',
        ...(row.target?.sources ? { target_found_by: row.target.sources } : {}), inputs: Object.fromEntries(Object.entries(row.inputs ?? {}).map(([name, spec]) => [name, `${spec.type}${spec.required ? ' (required)' : ''}`])) })),
      target: 'A label string, or { match: { label | role | title | description | value | identifier | text: string or { equals | contains | starts_with | regex } }, source?: ax | ocr, nth? }',
      expect: 'A list of { target, min?, max? } (how many matches must be on the screen after) or { changed: true | false }.' };
    },

    /** observe → locate → act → observe → verify, in one call, after any drive already running has finished. A secret the call typed is masked in all it says. */
    drive(input = {}, account = {}) {
      return oneAtATime(async () => {
        const secrets = [];
        try { return masked(await driveOnce(input, account, secrets), secrets, settings.secrets.mask); }
        catch (error) {
          if (secrets.length && typeof error?.message === 'string') error.message = masked(error.message, secrets, settings.secrets.mask);
          throw error;
        }
      });
    },
  };
  return { ...driver, look: withRetry(driver.look), find: withRetry(driver.find), drive: withRetry(driver.drive) };
}

let shared = null;
const driverHere = () => (shared ??= makeScreenDriver());

export const screenTools = {
  look: input => driverHere().look(input),
  find: input => driverHere().find(input),
  actions: () => driverHere().actions(),
  drive: (input, account) => driverHere().drive(input, account),
};

// The person's own command line: node computer/drive-the-screen.mjs grant --actions look,press --minutes 10 [--apps Safari]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = name => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
  const tools = grantTools();
  const list = name => flag(name)?.split(',').map(item => item.trim()).filter(Boolean);
  try {
    const answer = command === 'grant' ? tools.grant({ actions: rest.includes('--all-actions') ? tools.known : list('actions'), apps: list('apps') ?? [], minutes: flag('minutes') ? Number(flag('minutes')) : undefined, uses: flag('uses') ? Number(flag('uses')) : rest.includes('--once') ? 1 : undefined })
      : command === 'revoke' ? tools.revoke({ id: flag('id') }) : command === 'grants' ? tools.grants()
        : ['allow', 'deny', 'unallow', 'undeny'].includes(command) ? ruleTools(decisionOf(screenSettings()))[command.startsWith('un') ? 'remove' : 'add']({ list: command.endsWith('allow') ? 'user_allow' : 'user_deny',
          rule: Object.fromEntries(['action', 'app', 'url'].filter(name => flag(name) !== undefined).map(name => [name, flag(name)])) })
          : command === 'strict' ? ruleTools(decisionOf(screenSettings())).strict(flag('state') !== 'off')
            : command === 'rules' ? ruleTools(decisionOf(screenSettings())).rules() : command === 'propose' ? ruleTools(decisionOf(screenSettings())).propose() : null;
    if (!answer) throw new Error('Use grant, revoke, grants, allow, deny, unallow, undeny, strict, rules or propose.');
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
