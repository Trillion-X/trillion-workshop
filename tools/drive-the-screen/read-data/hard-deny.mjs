// tools/drive-the-screen/read-data/hard-deny.mjs
//
// PURPOSE
//   The screen driver's hard deny list (./hard-deny.json): what no AI may do on this Mac's screen whatever the person's own
//   rules, grants or the call say. An AI never grants itself a Mac permission, types or reads a password, confirms a payment,
//   or answers the system's authentication sheets. ./drive-the-screen.mjs asks it twice in every drive: on what the call asks
//   for (requestRefusal, before the screen is read) and on the resolved target (targetRefusal, before anything is done or
//   rehearsed).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every app, pane, role and label is ./hard-deny.json; this file only matches.
//   2. No switch: nothing in the call, the person's rules file or the driver's settings turns a rule off.
//   3. A refusal names its rule id and says its words; it never says how to get around it.
//   4. When a part cannot be judged (no window titles, no target), only the conditions whose parts are all known can match;
//      the second check, on the resolved target, judges the rest.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hardDenyList = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hard-deny.json'), 'utf8'));

const lower = value => String(value ?? '').toLowerCase();
const stripRole = role => lower(role).replace(/^ax/, '');
const identities = (list, app) => (app ? [app.name, app.bundle_id].filter(Boolean).map(lower) : []);

// An `app` part names an identity, or `@group` from app_identities.
const appNames = (list, part) => (part.startsWith('@') ? list.app_identities?.[part.slice(1)] ?? [] : [part]).map(lower);
const matches = (pattern, values) => values.some(value => typeof value === 'string' && new RegExp(pattern, 'i').test(value));

/** Whether one condition matches what is known. `known` holds apps (identity lists), windows, role(s), labels, writes, untargeted, credentialSurface. */
function conditionMatches(list, condition, known) {
  const parts = Object.entries(condition);
  if (!parts.length) return false;
  for (const [name, value] of parts) {
    if (name === 'app') { if (!known.apps.some(app => appNames(list, value).some(id => app.includes(id)))) return false; }
    else if (name === 'window') { if (!known.windows?.length || !matches(value, known.windows)) return false; }
    else if (name === 'role') { if (!known.roles?.length || !known.roles.includes(stripRole(value))) return false; }
    else if (name === 'label') { if (!known.labels?.length || !matches(value, known.labels)) return false; }
    else if (name === 'writes') { if (known.writes !== value) return false; }
    else if (name === 'untargeted_on_credential_surface') { if (!(value === true && known.writes && known.untargeted && known.credentialSurface)) return false; }
    else return false;
  }
  return true;
}

/** The first rule that matches, or null. */
export function firstRule(list, known) {
  return list.rules.find(rule => rule.when.some(condition => conditionMatches(list, condition, known))) ?? null;
}

const refusal = (list, rule) => Object.assign(new Error(list.words.refused.replace('{rule}', rule.id).replace('{said}', rule.said)),
  { status: 403, retry: false, rule: rule.id, reaction: 'ask_user' });

// The words a target names: a label string, or the text matchers of { match: { label | title | description | value | text } }.
const targetWords = target => {
  if (typeof target === 'string') return [target];
  const match = target?.match;
  if (!match || typeof match !== 'object') return [];
  return Object.entries(match).filter(([field]) => field !== 'role' && field !== 'subrole')
    .map(([, spec]) => (typeof spec === 'string' ? spec : spec?.equals ?? spec?.contains ?? spec?.starts_with)).filter(value => typeof value === 'string');
};
const targetRoles = target => {
  const match = target?.match;
  return ['role', 'subrole'].map(field => (typeof match?.[field] === 'string' ? match[field] : match?.[field]?.equals)).filter(Boolean).map(stripRole);
};

/** Before the screen is read: the app the call names and the target it describes. Throws the refusal, or returns. */
export function requestRefusal(list, { app, target, to, writes }) {
  const known = { apps: app ? [[lower(app)]] : [], labels: [...targetWords(target), ...targetWords(to)], roles: [...targetRoles(target), ...targetRoles(to)], writes: writes === true };
  const rule = firstRule(list, known);
  if (rule) throw refusal(list, rule);
}

/** Before anything is done: the resolved targets, the app driven and the app in front, the app's window titles. */
export function targetRefusal(list, { app, frontmost, windows = [], targets = [], writes = false, credentialSurface = false }) {
  const apps = [identities(list, app), identities(list, frontmost)].filter(ids => ids.length);
  const roles = targets.flatMap(element => [element?.fields?.role, element?.fields?.subrole, element?.raw?.subrole, element?.raw?.role]).filter(Boolean).map(stripRole);
  const labels = targets.flatMap(element => [element?.fields?.label, element?.fields?.title, element?.fields?.description, element?.fields?.text, element?.raw?.title, element?.raw?.description]).filter(value => typeof value === 'string' && value);
  const known = { apps, windows: windows.filter(Boolean), roles, labels, writes, untargeted: targets.length === 0, credentialSurface };
  const rule = firstRule(list, known);
  if (rule) throw refusal(list, rule);
}
