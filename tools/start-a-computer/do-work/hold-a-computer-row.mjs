// tools/start-a-computer/do-work/hold-a-computer-row.mjs
//
// One apply of a computer's row at a time. apply-a-computer-row.mjs holds the row from before it reads it until after its last
// write-back, as a PostgreSQL advisory lock taken on its own database session, kept open for the whole apply: the lock is the
// pair (hashtext of LOCK_CLASS, hashtext of the row's name), so it covers that one row and no other. A second apply of the same
// row is refused at once, never kept waiting, and its refusal names who holds the row and since when: the holder writes its
// words into its own session's last statement, which the database shows any session of the same login (pg_stat_activity). The
// lock ends with its session, so an apply that dies, or a session the network drops, holds nothing afterwards. Before the
// row is written the holder checks it still holds the lock. A dry run and `differences` read and take no lock.
//
// Why (Nov 25 2026): four lanes shared one computer's row by messaging each other "row free" and "done", and two applies
// still raced: a preview read a row another apply was about to change (4:08 AM CST), and two applies nearly overlapped
// (5:30 AM CST).

export const LOCK_CLASS = 'apply-a-computer-row';
const MARK = 'apply-a-computer-row holds ';

// The lock's two keys as the database's lock list shows them: each int4 hash read as an unsigned oid.
const HELD_BY = `select a.pid, a.query, a.backend_start, a.client_addr::text as client_addr
  from pg_locks l join pg_stat_activity a on a.pid = l.pid
  where l.locktype = 'advisory' and l.granted and l.objsubid = 2
    and l.classid::bigint = (hashtext($1)::bigint & 4294967295) and l.objid::bigint = (hashtext($2)::bigint & 4294967295)`;

const refused = message => Object.assign(new Error(message), { exit: 3, row_held: true });

/** The holder's words from the last statement of the session that holds the row, or null when they are not there. */
export function holderIn(query) {
  const at = typeof query === 'string' ? query.indexOf(MARK) : -1;
  if (at < 0) return null;
  const rest = query.slice(at + MARK.length);
  const end = rest.lastIndexOf("' as holding");
  try { return JSON.parse((end < 0 ? rest : rest.slice(0, end)).replaceAll("''", "'")); } catch { return null; }
}

/** Why a second apply is refused: who holds the row and since when, from the holding session. */
export function heldWords(name, holding) {
  const holder = holderIn(holding?.query);
  const since = holder?.since ?? (holding?.backend_start ? new Date(holding.backend_start).toISOString() : 'an unknown time');
  const who = holder ? `${holder.by} (process ${holder.pid} on ${holder.host}${holder.log_folder ? `, logs in ${holder.log_folder}` : ''})`
    : `database session ${holding?.pid ?? 'unknown'}${holding?.client_addr ? ` from ${holding.client_addr}` : ''}`;
  return `the ${name} row is being applied by ${who} since ${since}; one apply of a row at a time, so this one was refused and wrote nothing. Ask again once it ends.`;
}

/**
 * Hold the row `name` for one apply, or refuse at once. `connect()` answers a connected pg client of its own session (one
 * client per hold, never shared with other statements); `holder` is { by, pid, host, log_folder? }; `now()` is ms.
 * Answers { holder, check(), release() }: check() refuses when the lock is no longer this session's; release() ends it.
 */
export async function holdComputerRow(name, { connect, holder, now = () => Date.now() }) {
  const client = await connect();
  let lost = null;
  client.on('error', error => { lost = error; });
  const words = { ...holder, since: new Date(now()).toISOString() };
  const mark = async () => client.query(`select ${client.escapeLiteral(MARK + JSON.stringify(words))} as holding`);
  try {
    const { rows: [got] } = await client.query('select pg_try_advisory_lock(hashtext($1), hashtext($2)) as got', [LOCK_CLASS, name]);
    if (got?.got !== true) {
      const { rows: [holding] } = await client.query(HELD_BY, [LOCK_CLASS, name]);
      throw refused(heldWords(name, holding));
    }
    await mark();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return {
    holder: words,
    async check() {
      if (lost) throw refused(`the hold on the ${name} row was lost (${lost.message}); nothing more was written.`);
      const { rows } = await client.query(`${HELD_BY} and l.pid = pg_backend_pid()`, [LOCK_CLASS, name]);
      if (rows.length !== 1) throw refused(`this apply no longer holds the ${name} row; nothing more was written.`);
      await mark();
    },
    // Never throws: ending the session ends the lock, whatever the unlock answered, and the apply's own outcome stands.
    async release() {
      if (!lost) await client.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [LOCK_CLASS, name]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}
