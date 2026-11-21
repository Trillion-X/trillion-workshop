/**
 * notice-when-something-shows-up/do-work/mechanisms/row-changes.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for rows to change in a Postgres database, and
 *   report each change once. The database keeps its own changes in a change
 *   table that one trigger function writes in the same transaction as the change
 *   (the database's own setup makes both; this leaf only reads). A NOTIFY on the
 *   table's channel only wakes this leaf early; it also reads again every
 *   look_again_seconds, so a notice lost while nothing listened costs nothing.
 *
 * Non-negotiable invariants
 *   - Nothing is skipped and nothing is told twice. Rows are read in
 *     (txid, position) order and only those whose transaction is older than
 *     every transaction still running in this database (txid < the horizon,
 *     horizonSql), so a change committed later can never sort before one
 *     already passed. The kept place is the last told (txid, position).
 *   - A reader with no kept place starts from now: its first read keeps the
 *     newest change already committed below the horizon as its place, tells
 *     nothing before it, and keeps that place at once, so a crash before its
 *     first change does not replay the table either. Nov 20 2026, 2:15 PM
 *     CST: a reader first switched on for the person's own database on the
 *     always-on computer told all 189 old changes, and 122 owed causes were let
 *     go, the one it was switched on for among them. from_the_start (a
 *     setting) tells the whole table instead, for a reader that must see every
 *     change ever made.
 *   - The horizon is this database's own. The server's (pg_snapshot_xmin) waits
 *     for transactions in every database on it, and a transaction in another
 *     database can never write this one's change table: Nov 20 2026, 7:29:55 to
 *     7:41 and again from 7:58 AM CST, one session idle in a transaction on
 *     another database held every row change on the Mac back. A running
 *     transaction is left out of the horizon only when pg_locks and
 *     pg_stat_activity (both readable by any login) show its session connected
 *     to another database; any it cannot place (a prepared transaction, one
 *     that ended while it looked) still holds the horizon.
 *   - Each change is told under its own event key, <database>:<txid>:<position>,
 *     so telling it again is one fact to the engine.
 *   - It names no table of the person's: the change table and channel are
 *     settings (row_changes by default), and each change says its own table.
 *   - It never writes to the database. Its login needs to read the change table.
 *   - Who made each change is told as by: the change table's changed_by (a column the database fills with the login
 *     that made the change, `changed_by text DEFAULT current_user`), null for a table that keeps none.
 *   - A change carries itself: before and after as JSON text when each fits a fact
 *     field (CARRIED_BYTES), else null, so a woken run needs no reader tool; key is
 *     the change's own key in this database's words, for a run that reads more.
 *     This leaf is one way a Postgres database tells its changes, one transport
 *     among many: nothing shared names it, and another store tells its changes
 *     its own way (workflow:tell-me-when-something-changes).
 *   - Changes held back are told, once: committed changes that wait behind one
 *     transaction still running in this database for held_back_seconds are
 *     told as the waiter's trouble
 *     (handlers.onTrouble), naming the holding session's pid and database when
 *     this login may see them. Nov 20 2026, 7:29:55 to 7:41 AM CST: one session
 *     left idle in a transaction on another database (pid 415254) held every
 *     row change on the Mac back for 11 minutes, and nothing said so.
 *
 * Settings (mechanism_settings)
 *   connection_fd       the descriptor holding the connection string (default 4; a waiter that names its own credential_name reads it from the descriptor the run gave it instead)
 *   table, channel      the change table and its NOTIFY channel (row_changes)
 *   look_again_seconds  the longest wait between reads (default 30)
 *   most_per_read       the most changes told in one batch (default 100); a backlog is told batch by batch
 *   catch_up_pause_seconds  the pause between batches while a backlog is told (default 2), so a long gap never floods the router
 *   from_the_start      true to tell every change already in the table when
 *                       there is no kept place (default false: start from now)
 *   held_back_seconds   how long committed changes may wait behind a running
 *                       transaction before that is told (default 120: longer
 *                       than the one minute after which the server ends a
 *                       session idle in a transaction, held_database's
 *                       idle_in_transaction_session_timeout, so a hold the server
 *                       ends itself is never told)
 */
import { readFileSync } from "node:fs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::row-changes";
const NAME = /^[a-z_][a-z0-9_]*$/;
// A told fact holds at most 1,024 bytes a field (the engine's fact inbox, src/wake/host-events.json); a value longer than this is left out.
export const CARRIED_BYTES = 1000;
// A change's kind in the fact's own words: the store's INSERT, UPDATE and DELETE become added, changed and removed.
export const changeOf = (op) => ({ INSERT: "added", UPDATE: "changed", DELETE: "removed" })[op] ?? String(op).toLowerCase();
export const carried = (value) => {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text) <= CARRIED_BYTES ? text : null;
};

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "before", "after", "by"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const number = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const table = typeof settings.table === "string" && NAME.test(settings.table) ? settings.table : "row_changes";
  const channel = typeof settings.channel === "string" && NAME.test(settings.channel) ? settings.channel : table;
  return {
    connection_fd: number(settings.connection_fd, 4),
    table,
    channel,
    look_again_ms: number(settings.look_again_seconds, 30) * 1000,
    most_per_read: number(settings.most_per_read, 100),
    catch_up_pause_ms: number(settings.catch_up_pause_seconds, 2) * 1000,
    held_back_ms: number(settings.held_back_seconds, 120) * 1000,
    from_the_start: settings.from_the_start === true,
  };
}

/** The read that says whether committed changes wait behind a transaction running in this database: the horizon, how
 *  many changes wait at or after it, and the session holding it (pg_locks names its pid to any login; its state and
 *  start only when this login may see them). */
export const heldBackSql = (table) => `WITH h AS (SELECT ${horizonSql} AS horizon)
SELECT (SELECT horizon::text FROM h) AS xmin,
  (SELECT count(*) FROM ${table} WHERE txid >= (SELECT horizon FROM h))::int AS waiting,
  current_database() AS database,
  (SELECT json_build_object('pid', a.pid, 'database', a.datname, 'state', a.state, 'since', a.xact_start)
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted
       AND l.transactionid::text::bigint = ((SELECT horizon FROM h)::text::bigint % 4294967296) LIMIT 1) AS holder`;

/** Who holds changes back, in words: the session's pid, database, state and since when, as far as they can be seen. */
export function heldBackWords({ waiting, database, holder }, heldMs) {
  const minutes = Math.max(1, Math.round(heldMs / 60000));
  const seen = [holder?.state, holder?.since ? `since ${new Date(holder.since).toISOString()}` : null].filter(Boolean).join(' ');
  const who = holder?.pid
    ? `session ${holder.pid} on ${holder.database ?? 'a database this login may not name'}${seen ? ` (${seen})` : ''}`
    : 'a session this login may not see';
  const changes = waiting === 1 ? '1 committed change has' : `${waiting} committed changes have`;
  return `${changes} waited in ${database} for ${minutes} min behind a transaction still running: ${who}. They are told once that transaction ends (pg_terminate_backend on its pid ends it).`;
}

/** The oldest transaction still running in this database, as of this statement's snapshot (the snapshot's xmax when none
 *  is): every running transaction ID in the snapshot but those whose session pg_locks and pg_stat_activity place in
 *  another database. A transaction ID is 32 bits in pg_locks and 64 in the snapshot, so they meet modulo 2^32. */
export const horizonSql = `coalesce((SELECT min(x) FROM pg_snapshot_xip(pg_current_snapshot()) x
    WHERE (x::text::bigint % 4294967296) NOT IN (SELECT l.transactionid::text::bigint FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted AND a.datname IS NOT NULL AND a.datname <> current_database())),
  pg_snapshot_xmax(pg_current_snapshot()))`;

/** The place a reader with no kept place starts from: the newest change already committed below the horizon (none when the
 *  table holds none yet). */
export const nowSql = (table) => `SELECT txid::text AS txid, position::text AS position FROM ${table}
  WHERE txid < ${horizonSql} ORDER BY txid DESC, position DESC LIMIT 1`;

/** The read that takes the next changes after `after` ({txid, position} or null), oldest first. */
export const readSql = (table) => `SELECT position::text AS position, txid::text AS txid, at, table_name, op, before, after, to_jsonb(c) ->> 'changed_by' AS by, current_database() AS database
  FROM ${table} c
  WHERE txid < ${horizonSql} AND ($1::xid8 IS NULL OR (txid, position) > ($1::xid8, $2::bigint))
  ORDER BY txid, position LIMIT $3`;

// A run the engine sandboxes reaches the database only through the run's own proxy, which the engine names in HTTPS_PROXY:
// a direct connect is refused (EPERM). The tunnel is run-sql-in-my-database's, laid beside this tool by the row.
/** A connection that is refused, or a read that fails while the waiter watches, is a crash, not the end of the waiter: the
 *  caller exits non-zero so the supervisor restarts it with backoff. A clean return from watchForTransitions means only
 *  that the waiter is done (its signal ended). Nov 20 2026, 4:24:35 PM CST: a proxy answering 502 made the one waiter that
 *  watched the person's own pursuit database return cleanly, the process exited 0, and no row change was told after that. */
export function crashed(error, why) {
  const failure = new Error(`${why}: ${error?.message ?? error}`, { cause: error });
  failure.crash = true;
  failure.reason = "connection-failed";
  return failure;
}

export async function clientOptions(connection, proxy = process.env.HTTPS_PROXY) {
  if (!proxy) return { connectionString: connection };
  const { throughProxy } = await import("../../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs");
  return { connectionString: connection, stream: throughProxy(proxy) };
}

async function connectWithPg(connection) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(await clientOptions(connection));
  await client.connect();
  return client;
}

/** One look at whether changes wait behind a running transaction; told once per horizon after held_back_ms. A look that
 *  fails changes nothing: the changes are read as before, and the next look tries again. */
async function lookForHeldBack(client, own, held, handlers) {
  const now = (handlers.now ?? Date.now)();
  let found;
  try {
    found = (await client.query(heldBackSql(own.table))).rows?.[0];
  } catch {
    return held;
  }
  if (!found || !(found.waiting > 0)) return null;
  const same = held?.xmin === found.xmin ? held : { xmin: found.xmin, since: now, told: false };
  if (same.told || now - same.since < own.held_back_ms) return same;
  const told = await handlers.onTrouble?.({
    event_key: `${found.database}:held-back:${found.xmin}`,
    cause: 'row-changes-held-back',
    said: heldBackWords(found, now - same.since),
  });
  return { ...same, told: told !== false };
}

/**
 * Wait for row changes and report each once.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, onTrouble, signal, state (last kept {after}), keepState, and for tests: connect, connection, now
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  const connection = handlers.connection ?? readFileSync(handlers.credentialFd ?? own.connection_fd, "utf8").trim();
  let client;
  try {
    client = await (handlers.connect ?? connectWithPg)(connection);
  } catch (error) {
    throw crashed(error, `row-changes could not connect to ${own.table}`);
  }
  let state = handlers.state?.after !== undefined ? handlers.state : { after: null };
  let wake = () => {};
  // The horizon changes wait behind, since when, and whether that hold was told.
  let held = null;
  client.on?.("notification", (message) => { if (message.channel === own.channel) wake(); });
  try {
    await client.query(`LISTEN ${own.channel}`);
    if (state.after === null && !own.from_the_start) {
      const newest = (await client.query(nowSql(own.table))).rows?.[0];
      if (newest) {
        state = { after: { txid: newest.txid, position: newest.position } };
        await keepState(state);
      }
    }
    while (!signal?.aborted) {
      const { rows } = await client.query(readSql(own.table), [state.after?.txid ?? null, state.after?.position ?? null, own.most_per_read]);
      let refused = false;
      for (const change of rows) {
        if (signal?.aborted) return;
        const next = { after: { txid: change.txid, position: change.position } };
        const told = await handlers.onTransition({
          condition: "became-reachable",
          observed_identity: { where: change.database, place: change.table_name },
          event_key: `${change.database}:${change.txid}:${change.position}`,
          state: next,
          detail: { where: change.database, place: change.table_name, change: changeOf(change.op), at: new Date(change.at).toISOString(),
            key: `${change.database}:${change.txid}:${change.position}`,
            before: carried(change.before), after: carried(change.after), by: change.by ?? null },
        });
        if (told === false) { refused = true; break; }
        state = next;
        // The kept place is written after each told change, so a restart resumes after it, never from now.
        await keepState(state);
      }
      if (rows.length === own.most_per_read && !refused) {
        // A backlog longer than one batch is told in batches with a pause, so the router hears a steady rate.
        await new Promise((resolve) => setTimeout(resolve, own.catch_up_pause_ms));
        continue;
      }
      if (signal?.aborted) return;
      held = await lookForHeldBack(client, own, held, handlers);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, own.look_again_ms);
        wake = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener("abort", wake, { once: true });
      });
      wake = () => {};
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw crashed(error, `row-changes lost ${own.table}`);
  } finally {
    await keepState(state).catch(() => {});
    await client.end?.().catch?.(() => {});
  }
}
