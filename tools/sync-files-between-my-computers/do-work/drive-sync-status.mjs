// tools/sync-files-between-my-computers/do-work/drive-sync-status.mjs (moved from old trillion computer/drive-sync-status.mjs)
//
// PURPOSE
//   One typed sync status record for the person's synced files on one computer, so a screen or a program never has to
//   guess between "nothing is there" and "not read yet": which state the sync is in, whether Trillion was reached and
//   why not, the change count it has read up to, and how many saves are still moving.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which state applies, what causes a failure is filed under and every word are DATA (sync-files.json
//      `sync_status`). A state is the first row whose every condition holds; a new state or cause is one row.
//   2. Facts only: every number comes from what the drive observed (its change feed and its write journal); a feed
//      that was never answered is its own fact (`checked: false`), never read as reached or as empty.
//   3. Names, file identities and the account key never enter the record; it carries counts, a cause and a status.
import { readFileSync } from 'node:fs';

const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The cause a failure is filed under: the first `causes` row whose statuses hold, else `cause_otherwise`. */
export function causeOf(rules, failure) {
  if (!failure) return null;
  const status = Number.isInteger(failure.status) ? failure.status : null;
  const row = rules.causes.find(rule => (rule.without_status === true && status === null)
    || (status !== null && Array.isArray(rule.statuses) && rule.statuses.includes(status))
    || (status !== null && Number.isInteger(rule.status_at_least) && status >= rule.status_at_least));
  return row?.cause ?? rules.cause_otherwise;
}

const holds = (condition, facts) => {
  const value = facts[condition.fact];
  if (Object.hasOwn(condition, 'equals')) return value === condition.equals;
  if (Number.isFinite(condition.at_least)) return typeof value === 'number' && value >= condition.at_least;
  return false;
};

/**
 * The record. `feed` is what the drive's change feed observed: { version, reached_at, failure: { status?, at } | null }
 * (times in ms). `writes` is the write journal's status answer (the write journal's status()) or null when the
 * writable mount is off.
 */
export function driveSyncStatus({ rules, feed, writes = null }) {
  const owing = writes?.owing ?? [];
  const reached = feed.reached_at !== null && (!feed.failure || feed.failure.at <= feed.reached_at);
  const facts = {
    checked: feed.reached_at !== null || feed.failure !== null,
    reached,
    moving: owing.length,
    conflicts: writes?.conflicts?.length ?? 0,
    failed: writes?.failed?.length ?? 0,
  };
  const row = rules.states.find(rule => (rule.when ?? []).every(condition => holds(condition, facts)));
  const cause = reached ? null : causeOf(rules, feed.failure);
  const bytes = owing.reduce((total, write) => total + (Number.isSafeInteger(write.size) ? write.size : 0), 0);
  return {
    state: row.state,
    version: feed.version,
    network: { checked: facts.checked, reached, last_reached_at: feed.reached_at === null ? null : new Date(feed.reached_at).toISOString() },
    error: cause ? { cause, status: feed.failure.status ?? null, at: new Date(feed.failure.at).toISOString(), said: rules.cause_words[cause] ?? null } : null,
    moving: { count: facts.moving, bytes },
    conflicts: facts.conflicts,
    failed: facts.failed,
    said: fill(row.said, { moving: facts.moving, conflicts: facts.conflicts, failed: facts.failed, cause: cause ? rules.cause_words[cause] ?? cause : '' }),
  };
}

/** The DATA blocks of sync-files.json beside this file (sync_status, peers, folder_bindings). */
export const settingsOf = () => JSON.parse(readFileSync(new URL('./sync-files.json', import.meta.url), 'utf8'));

/**
 * The tool seam (tool:say-where-file-sync-stands), run by tools/records-door/do-work/run-an-export.mjs: the record from
 * what one computer's change feed and write journal observed, by the `sync_status` rules in sync-files.json.
 */
export function sayWhereFileSyncStands(input = {}) {
  const feed = input.feed;
  if (!feed || typeof feed !== 'object') throw new Error('Give feed: { version, reached_at, failure }.');
  const clean = { version: feed.version ?? null, reached_at: Number.isFinite(feed.reached_at) ? feed.reached_at : null, failure: feed.failure ?? null };
  return driveSyncStatus({ rules: settingsOf().sync_status, feed: clean, writes: input.writes ?? null });
}
