// computer/run-decision.mjs
//
// PURPOSE
//   The one decision table for whether this Mac's screen driver may do an action in an app (the table is
//   computer/run-decision.json). Four lists are read in a fixed order, first match wins: the person's deny list, the
//   person's allow list, an organisation's deny list, an organisation's allow list. No match falls to the table's
//   `otherwise`: allowed, unless the person turned strict on, then refused. Reading the screen is an action like any
//   other, so a sensitive app can be kept unread by the same rule that keeps it untouched.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is on by default: with no rules file and no controls file every action is allowed (the table's
//      `otherwise.open`). A rule, strict and organisation controls each exist only because someone wrote them.
//   2. The files are read again at every decision. One that exists but cannot be trusted (not JSON, wrong shape,
//      writable by others) refuses, never allows: a rule the person wrote must not silently stop applying.
//   3. Organisation controls arrive as one record. A refresh that fails keeps the last record fetched successfully;
//      with none yet, the table's `controls.without_last_good` decides (deny). Only a configured source is fetched.
//   4. Nothing here names an app, action or site: rules, order, outcomes and words are DATA.
//   6. A refusal carries `reason`, a stable code from the table's `reasons` (denied-by-list, strict-not-allowed, rules-unreadable,
//      controls-missing, hook-denied, hook-failed), so a caller says why in its own words and never parses sentences.
//   7. Hooks are the person's own and run only when they listed some: a hook that cannot answer is `hooks.on_failure` (deny).
//   5. The person's allow proposals come from approvals they already gave (the history grant() keeps), as the
//      narrowest rule that would have admitted each, shown for them to accept; nothing is added without their command.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const decisionSettings = () => JSON.parse(readFileSync(join(HERE, 'run-decision.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 403, reason = null) => Object.assign(new Error(message), { status, ...(reason ? { reason } : {}) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = value => String(value ?? '').toLowerCase();
const PARTS = ['action', 'app', 'url'];

/** A text with * as the wildcard, matched whole and ignoring case. */
const globMatches = (pattern, value) => new RegExp(`^${lower(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'u').test(lower(value));

/** Whether one rule holds for a subject { action, app (name or list of names), url }. */
export function ruleHolds(rule, subject) {
  return PARTS.every(part => {
    if (rule[part] === undefined) return true;
    const values = [].concat(subject[part] ?? []).filter(value => value !== undefined && value !== null && value !== '');
    return [].concat(rule[part]).some(pattern => values.some(value => globMatches(pattern, value)));
  });
}

/** A rule shaped and checked, or a refusal saying why. */
export function checkedRule(settings, rule) {
  const problem = !object(rule) ? 'it is an object'
    : Object.keys(rule).some(key => !PARTS.includes(key)) ? `its parts are ${PARTS.join(', ')}`
      : Object.values(rule).some(value => ![].concat(value).every(item => typeof item === 'string' && item.length > 0)) ? 'each part is text or a list of text' : null;
  if (problem) throw refusal(fill(settings.words.bad_rule, { problem }), 400);
  return Object.fromEntries(PARTS.filter(part => rule[part] !== undefined).map(part => [part, rule[part]]));
}

/**
 * The decision for a subject over the lists { user_deny, user_allow, system_deny, system_allow }: { decision, by, rule }.
 * `by` is the list that decided, or `otherwise`; `rule` the rule that held, or null.
 */
export function decide(settings, lists, subject, { strict = false } = {}) {
  for (const name of settings.order) {
    const rule = (lists[name] ?? []).find(item => ruleHolds(item, subject));
    if (rule) return { decision: settings.outcomes[name], by: name, rule };
  }
  return { decision: strict ? settings.otherwise.strict : settings.otherwise.open, by: 'otherwise', rule: null };
}

// ---------------------------------------------------------------------------------------------------------- files

const trusted = file => {
  try {
    if (statSync(file).mode & 0o022) return { ok: false };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return object(value) ? { ok: true, value } : { ok: false };
  } catch (error) { return error?.code === 'ENOENT' ? { ok: true, value: null } : { ok: false }; }
};
const save = (file, value) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.next`;
  writeFileSync(next, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, file);
};
const listOf = value => (Array.isArray(value) ? value.filter(object) : []);

/** The lists in force now, read fresh: { ok, lists, strict, controlsMissing }. */
export function readLists(settings, home = homedir()) {
  const own = trusted(join(home, settings.rules_file));
  const org = trusted(join(home, settings.controls.file));
  if (!own.ok || !org.ok) return { ok: false };
  const mine = own.value ?? {}, theirs = org.value ?? {};
  return { ok: true, strict: mine.strict === true || theirs.strict === true, controlsMissing: settings.controls.source && !org.value,
    lists: { user_deny: listOf(mine.user_deny), user_allow: listOf(mine.user_allow), system_deny: listOf(theirs.system_deny), system_allow: listOf(theirs.system_allow) } };
}

/** Refuses (403) when the table says no for this action in this app; returns the decision otherwise. */
export function requireAllowed(settings, home, subject) {
  const state = readLists(settings, home);
  if (!state.ok) throw refusal(settings.words.unreadable, 403, settings.reasons.unreadable);
  if (state.controlsMissing && settings.controls.without_last_good === 'deny') throw refusal(settings.words.no_controls, 403, settings.reasons.no_controls);
  const decision = decide(settings, state.lists, subject, { strict: state.strict });
  if (decision.decision !== 'allow') {
    const app = subject.app?.[0] ? ` in ${subject.app[0]}` : '';
    throw decision.by === 'otherwise' ? refusal(fill(settings.words.strict, { action: subject.action, app }), 403, settings.reasons.strict)
      : refusal(fill(settings.words.denied, { action: subject.action, app, list: decision.by, rule: JSON.stringify(decision.rule) }), 403, settings.reasons.denied);
  }
  return decision;
}

/** One hook program run on the subject: its parsed answer, or { problem } when it could not give one. */
function runHook(settings, hook, subject) {
  return new Promise(done => {
    const limit = Number.isFinite(hook.timeout_ms) && hook.timeout_ms > 0 ? hook.timeout_ms : settings.hooks.timeout_ms;
    let child, out = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish({ problem: `no answer in ${limit} ms` }); }, limit);
    try { child = spawn(hook.command[0], hook.command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error) { finish({ problem: String(error?.message ?? error).slice(0, 120) }); return; }
    child.on('error', error => finish({ problem: String(error?.message ?? error).slice(0, 120) }));
    child.stdout.on('data', chunk => { out += chunk; if (out.length > settings.hooks.answer_bytes) { child.kill('SIGKILL'); finish({ problem: 'the answer was too long' }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(subject));
    child.on('close', code => {
      if (code !== 0) return finish({ problem: `it exited ${code}` });
      try { const answer = JSON.parse(out); finish(object(answer) && ['allow', 'deny'].includes(answer.decision) ? answer : { problem: 'it did not answer allow or deny' }); }
      catch { finish({ problem: 'its answer was not JSON' }); }
    });
  });
}

/** Runs the person's hooks for a subject; refuses (403) when one denies, or cannot answer while hooks.on_failure is deny. No hooks listed, nothing runs. */
export async function requireHooks(settings, home, subject) {
  const state = trusted(join(home, settings.rules_file));
  if (!state.ok) throw refusal(settings.words.unreadable, 403, settings.reasons.unreadable);
  const step = subject.step ?? 'before_action';
  const blocking = settings.hooks.steps?.[step]?.blocking !== false;
  const hooks = listOf(state.value?.hooks).filter(hook => Array.isArray(hook.command) && hook.command.length && hook.command.every(part => typeof part === 'string' && part))
    .filter(hook => (hook.step ?? 'before_action') === step && (typeof hook.matcher !== 'string' || globMatches(hook.matcher, subject.action))).slice(0, settings.hooks.max_hooks);
  const app = subject.app?.[0] ? ` in ${subject.app[0]}` : '';
  for (const hook of hooks) {
    const answer = await runHook(settings, hook, subject);
    const name = hook.command[0];
    if (!blocking) continue;
    if (answer.problem) {
      if (settings.hooks.on_failure === 'allow') continue;
      throw refusal(fill(settings.words.hook_failed, { action: subject.action, app, hook: name, problem: answer.problem }), 403, settings.reasons.hook_failed);
    }
    if (answer.decision === 'deny') throw refusal(fill(settings.words.hook_denied, { action: subject.action, app, hook: name, reason: String(answer.reason ?? 'no reason given').slice(0, 200) }), 403, settings.reasons.hook_denied);
  }
}

/**
 * Fetches the organisation's controls from the configured source (never otherwise) and keeps the record that came, as
 * the last good one. A failed or unreadable answer changes nothing. Throttled by the controls file's own age.
 */
export async function refreshControls(settings, { home = homedir(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  const source = settings.controls.source;
  if (!source) return { refreshed: false, reason: 'no source' };
  const file = join(home, settings.controls.file);
  if (existsSync(file) && now() - statSync(file).mtimeMs < settings.controls.refresh_minutes * 60_000) return { refreshed: false, reason: 'fresh' };
  try {
    const answer = await fetchImpl(source, { signal: AbortSignal.timeout(settings.controls.timeout_ms), redirect: 'error' });
    if (!answer.ok) throw new Error(`answered ${answer.status}`);
    const record = await answer.json();
    if (!object(record)) throw new Error('not a record');
    const clean = { system_deny: listOf(record.system_deny).map(rule => checkedRule(settings, rule)), system_allow: listOf(record.system_allow).map(rule => checkedRule(settings, rule)),
      ...(record.strict === true ? { strict: true } : {}) };
    save(file, clean);
    return { refreshed: true };
  } catch (error) { return { refreshed: false, reason: String(error?.message ?? error).slice(0, 200), kept: existsSync(file) ? 'last good' : 'none' }; }
}

// ------------------------------------------------------------------------------------------- the person's commands

/** Rules the person keeps, an approval history, and allow proposals from it. Not Workshop tools. */
export function ruleTools(settings = decisionSettings(), { home = homedir() } = {}) {
  const rulesFile = join(home, settings.rules_file);
  const historyFile = join(home, settings.proposal.history_file);
  const mine = () => { const state = trusted(rulesFile); if (!state.ok) throw refusal(settings.words.unreadable); return state.value ?? {}; };
  const lists = ['user_deny', 'user_allow'];
  const checkedList = list => { if (!lists.includes(list)) throw refusal(fill(settings.words.bad_list, { list, lists: lists.join(', ') }), 400); return list; };
  return {
    add({ list, rule }) {
      checkedList(list);
      const kept = checkedRule(settings, rule);
      const current = mine();
      const rows = listOf(current[list]);
      if (!rows.some(row => JSON.stringify(row) === JSON.stringify(kept))) rows.push(kept);
      save(rulesFile, { ...current, [list]: rows });
      return { said: fill(settings.words.rule_added, { list, rule: JSON.stringify(kept) }) };
    },
    remove({ list, rule }) {
      checkedList(list);
      const current = mine();
      const rows = listOf(current[list]);
      const kept = rows.filter(row => JSON.stringify(row) !== JSON.stringify(checkedRule(settings, rule)));
      save(rulesFile, { ...current, [list]: kept });
      return { said: fill(settings.words.rule_removed, { list, count: rows.length - kept.length }) };
    },
    strict(on) { save(rulesFile, { ...mine(), strict: on === true }); return { said: fill(settings.words.strict_set, { state: on === true ? 'on' : 'off' }) }; },
    rules() { const current = mine(); return { strict: current.strict === true, user_deny: listOf(current.user_deny), user_allow: listOf(current.user_allow) }; },
    /** Remembers one approval the person gave (an action in an app) for proposals. */
    approved({ action, app = null, at = Date.now() }) {
      const state = trusted(historyFile);
      const rows = [...listOf(state.ok ? state.value?.approvals : []), { action, app, at }].slice(-settings.proposal.keep);
      save(historyFile, { approvals: rows });
    },
    /** The narrowest allow rule for each action-and-app approved at least min_repeats times and not already allowed. */
    propose() {
      const state = trusted(historyFile);
      const counts = new Map();
      for (const row of listOf(state.ok ? state.value?.approvals : [])) counts.set(JSON.stringify([row.action, row.app]), (counts.get(JSON.stringify([row.action, row.app])) ?? 0) + 1);
      const allowed = listOf(mine().user_allow);
      return { proposals: [...counts].filter(([, count]) => count >= settings.proposal.min_repeats).map(([key, count]) => {
        const [action, app] = JSON.parse(key);
        return { rule: { action, ...(app ? { app } : {}) }, approved_times: count };
      }).filter(({ rule }) => !allowed.some(row => JSON.stringify(row) === JSON.stringify(rule))) };
    },
  };
}
