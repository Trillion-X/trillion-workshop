// computer/drive-sync-status.mjs
//
// PURPOSE
//   One typed sync status record for the Trillion drive on this computer (computer/trillion-drive.mjs), so a screen or
//   a program never has to guess between "nothing is there" and "not read yet": which state the mount is in, whether
//   Trillion was reached and why not, the change count it has read up to, and how many saves are still moving.
//   The drive answers it at GET /?sync on its loopback port; the drives tool on this Mac carries it to the Drives
//   screen (computer/drive-tools/drives.mjs, src/drives-screen.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which state applies, what causes a failure is filed under and every word are DATA (trillion-drive.json
//      `sync_status`). A state is the first row whose every condition holds; a new state or cause is one row.
//   2. Facts only: every number comes from what the drive observed (its change feed and its write journal); a feed
//      that was never answered is its own fact (`checked: false`), never read as reached or as empty.
//   3. Names, file identities and the account key never enter the record; it carries counts, a cause and a status.

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
 * (times in ms). `writes` is the write journal's status answer (computer/drive-webdav.mjs status()) or null when the
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

/**
 * The record as the drive on this computer answers it (GET /?sync on its loopback `listen`), for a program beside it.
 * A drive that does not answer in `timeout_ms` is its own state (`not_running`), never an empty or synced drive.
 */
export async function readDriveSync({ settings, fetchImpl = fetch }) {
  const rules = settings.sync_status;
  try {
    const answer = await fetchImpl(`http://${settings.listen.host}:${settings.listen.port}/?sync`, { signal: AbortSignal.timeout(rules.read_timeout_ms) });
    if (answer.ok) return await answer.json();
    return { state: 'not_running', said: rules.not_running_said, status: answer.status };
  } catch { return { state: 'not_running', said: rules.not_running_said }; }
}
