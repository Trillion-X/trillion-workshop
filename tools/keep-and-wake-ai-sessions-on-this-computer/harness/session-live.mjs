// Whether a named session is already running on this computer, by the host's own listing command (a host row of
// harness/work-consumer.json: `live_check` is the command, `live_path` the field of each listed item that names a
// session). Answers { live: true | false } when the listing answered, or { live: null, why } when it could not be read
// (the command failed to start, exited non-zero, timed out or printed something that is not a list): not knowing is
// never read as "not running", so a caller does not start a session a second time on a failed check.
import { spawnSync } from 'node:child_process';

export function sessionLive({ live_check: check, live_path: field }, session, run = spawnSync) {
  if (!check) return { live: false };
  const listed = run(check[0], check.slice(1), { encoding: 'utf8', timeout: 15_000 });
  if (listed.error) return { live: null, why: String(listed.error.message ?? listed.error).slice(0, 200) };
  if (listed.status !== 0) return { live: null, why: (listed.stderr || `exit ${listed.status}`).trim().slice(0, 200) };
  let items;
  try { items = JSON.parse(listed.stdout); } catch { return { live: null, why: 'its listing was not readable' }; }
  if (!Array.isArray(items)) return { live: null, why: 'its listing was not a list' };
  return { live: items.some(item => item?.[field] === session) };
}
