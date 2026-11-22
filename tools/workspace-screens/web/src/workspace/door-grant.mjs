// src/workspace/door-grant.mjs
//
// PURPOSE
//   The pure decisions of the door grant screen (door-grant-screen.tsx), runnable in node: decode the grant a person was
//   sent (`?ask=`, base64url of the exact sharing.keep input), check its shape, build the door call for keep, list and
//   stop (each pinned to one of the person's computers with `?computer=`), and say what a grant and its last use read as.
//   The engine is the authority on every rule; this file only refuses a request it can see is malformed before anything
//   is sent, and it names no tool, person or computer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The keep input is sent exactly as the request carried it: no field is added, dropped or renamed here.
//   2. Each call names its computer in the address (`?computer=<id>`), never in the body, so the door sends it as `pins`.
//   3. Every word is read from door-grant-words.json; a refusal is keyed by the engine's code, never by its message.

import words from './door-grant-words.json' with { type: 'json' };

export const KEEP = 'sharing.keep';
export const LIST = 'sharing.list';
export const WITHDRAW = 'sharing.withdraw';

const MAX_LABEL_BYTES = 400;
const MAX_PEOPLE = 64;
const PRINCIPAL = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const nonEmpty = value => typeof value === 'string' && value.length > 0;
const labelFits = value => nonEmpty(value) && new TextEncoder().encode(value).length <= MAX_LABEL_BYTES;

/** The words with `{name}` filled from `values`; a name with no value is left as it is. */
export const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

// One person a grant names: a link holder (key_blake3) or a team member (team and issuer).
const personOk = person => isObject(person) && PRINCIPAL.test(person.principal)
  && ((onlyKeys(person, ['principal', 'key_blake3']) && DIGEST.test(person.key_blake3))
    || (onlyKeys(person, ['principal', 'team', 'issuer']) && nonEmpty(person.team) && nonEmpty(person.issuer)));

/** Why a keep input cannot be sent as it is (a reason key of words.problems), or null when its shape is right. */
export function problemOf(input) {
  if (!isObject(input) || !onlyKeys(input, ['label', 'on', 'sharing']) || input.on !== true || !isObject(input.sharing)) return 'invalid';
  if (!labelFits(input.label)) return 'label';
  const { sharing } = input;
  if (!onlyKeys(sharing, ['grant', 'people', 'ends'])) return 'invalid';
  const { grant, people, ends } = sharing;
  if (!isObject(grant) || !onlyKeys(grant, ['tools', 'identity', 'journal'])) return 'invalid';
  if (!Array.isArray(grant.tools) || grant.tools.length === 0 || !grant.tools.every(nonEmpty)) return 'tools';
  if (grant.identity !== 'none' && grant.identity !== 'self') return 'identity';
  if (grant.journal !== 'input' && grant.journal !== 'none') return 'journal';
  if (!Array.isArray(people) || people.length === 0 || people.length > MAX_PEOPLE || !people.every(personOk)) return 'people';
  if (ends !== undefined && !isObject(ends)) return 'invalid';
  return null;
}

const fromBase64url = text => {
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')), char => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

/** The grant an address asks to keep: `{ ok: true, input }`, or `{ ok: false, reason }` (a words.problems key). */
export function requestOf(ask) {
  if (!ask) return { ok: false, reason: 'no_request' };
  let input;
  try {
    input = JSON.parse(fromBase64url(ask));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const reason = problemOf(input);
  return reason ? { ok: false, reason } : { ok: true, input };
}

/** The address of one door method, pinned to a computer when one is named. */
export const doorPath = (method, computer) => `/work/api/door/${method}${computer ? `?computer=${encodeURIComponent(computer)}` : ''}`;

/** What one call to the door sends: a read for the list, a keyed POST for keep and stop. */
export function doorRequest(method, input, computer, requestKey) {
  const path = doorPath(method, computer);
  if (method === LIST) return { path, init: {} };
  return { path, init: { method: 'POST', body: JSON.stringify(input), headers: { 'idempotency-key': requestKey } } };
}

export const withdrawInput = label => ({ label: String(label) });

const dateWords = (iso, options) => {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : when.toLocaleString(undefined, options);
};

/** When a grant was last used: its own words, or never used when the engine has no use for it (null). */
export function lastUsedWords(lastUsed) {
  const when = lastUsed ? dateWords(lastUsed, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return when ? fill(words.last_used, { when }) : words.never_used;
}

/** Until when a grant is kept: its end rule's day, or until stopped. */
export function endsWords(ends) {
  const when = ends?.until ? dateWords(ends.until, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return when ? fill(words.ends_at, { when }) : words.never_ends;
}

/** Who a person entry names, in words. */
export function whoWords(person) {
  if (typeof person?.key_blake3 === 'string') return words.who_words.link;
  if (typeof person?.team === 'string') return fill(words.who_words.team, { principal: person.principal, team: person.team, issuer: person.issuer });
  return fill(words.who_words.person, { principal: person?.principal ?? '' });
}

/** The engine's refusal code as the words the screen shows; an unknown code is the plain refusal. */
const REFUSED = { current_workspace_rights_refused: 'rights', original_input_refused: 'input', original_workspace_source_unavailable: 'vault' };
export const refusalWords = code => words.refused[REFUSED[code]] ?? words.refused.other;

/** Whether a list the engine answered has the grant named by its label. */
export const isKept = (list, label) => Array.isArray(list?.grants) && list.grants.some(grant => grant?.label === label);

// The master auto-approve (workflow-engine src/approval.rs, CHECK_SQL): the approver's setting for the scope, else the master
// scope '*', decides. A setting in mode `auto` writes one approval_decision row in the same statement and the grant is kept
// without a press. Any other mode, no setting, or a check that cannot be read asks the person (one Allow press). The two
// tables are named by the approvals owner place (door-grant-approval.json), never here. A new scope is a row.
export const APPROVAL_SCOPE = 'door-grant';
export const APPROVAL_SQL = `
WITH setting AS (
  SELECT person, scope, mode, set_by FROM {setting}
  WHERE person = $1 AND scope IN ($2, '*')
  ORDER BY scope = $2 DESC
  LIMIT 1
), decided AS (
  INSERT INTO {decision} (id, post_id, person, at, decision, approved_how, setting_id, mode, reason, approved_by)
  SELECT gen_random_uuid()::text, $3, person, now(), 'approved', 'auto-setting', 'approval_setting:' || person || ':' || scope, mode, set_by, person
  FROM setting WHERE mode = 'auto'
  RETURNING id
)
SELECT setting.person, setting.scope, setting.mode, setting.set_by, decided.id AS decision_id
FROM setting LEFT JOIN decided ON true`;

const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** The check for one grant as its statement and parameters, from the approvals owner place (approver, table, decision_table);
 *  null when the place does not name a usable approver and plain table names, so the person is asked. */
export function approvalCheckOf(place, label) {
  const usable = nonEmpty(place?.approver) && TABLE_NAME.test(place?.table ?? '') && TABLE_NAME.test(place?.decision_table ?? '');
  if (!usable) return null;
  return {
    sql: APPROVAL_SQL.replaceAll('{setting}', place.table).replaceAll('{decision}', place.decision_table),
    params: [place.approver, APPROVAL_SCOPE, `grant:${String(label)}`],
  };
}

/** The check's answer rows as an auto decision, or null when the person must press Allow. An auto row with no decision id
 *  is not an auto decision (the engine refuses it too), so it asks. */
export function autoOf(rows) {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || row.mode !== 'auto' || typeof row.decision_id !== 'string' || !row.decision_id) return null;
  return { decision_id: row.decision_id, setting_id: `approval_setting:${row.person}:${row.scope}`, mode: row.mode };
}

/** The owner's notice for a grant kept under auto-approve: who may now use which tools on which computer, and the address of
 * the grants screen there. One row of their notices table, keyed by the label so the same grant tells once. */
export const KEPT_NOTICE_SQL = `insert into notices (title, body, url, made_at, kind, key) values ($1, $2, $3, now(), 'info', $4)`;
export function keptNoticeParams(input, computer) {
  const people = input?.sharing?.people ?? [];
  const values = { who: people.map(whoWords).join('; '), tools: (input?.sharing?.grant?.tools ?? []).join(', '), computer };
  return [words.kept_notice.title, fill(words.kept_notice.body, values), `/grants?computer=${encodeURIComponent(computer)}`, `grant-kept:${String(input?.label)}`];
}
