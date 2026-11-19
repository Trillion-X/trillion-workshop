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
 *     every transaction still running (txid < pg_snapshot_xmin of the current
 *     snapshot), so a change committed later can never sort before one already
 *     passed. The kept place is the last told (txid, position).
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
 *
 * Settings (mechanism_settings)
 *   connection_fd       the descriptor holding the connection string (default 4)
 *   table, channel      the change table and its NOTIFY channel (row_changes)
 *   look_again_seconds  the longest wait between reads (default 30)
 *   most_per_read       the most changes one read takes (default 500)
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
    most_per_read: number(settings.most_per_read, 500),
  };
}

/** The read that takes the next changes after `after` ({txid, position} or null), oldest first. */
export const readSql = (table) => `SELECT position::text AS position, txid::text AS txid, at, table_name, op, before, after, to_jsonb(c) ->> 'changed_by' AS by, current_database() AS database
  FROM ${table} c
  WHERE txid < pg_snapshot_xmin(pg_current_snapshot()) AND ($1::xid8 IS NULL OR (txid, position) > ($1::xid8, $2::bigint))
  ORDER BY txid, position LIMIT $3`;

// A run the engine sandboxes reaches the database only through the run's own proxy, which the engine names in HTTPS_PROXY:
// a direct connect is refused (EPERM). The tunnel is run-sql-in-my-database's, laid beside this tool by the row.
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

/**
 * Wait for row changes and report each once.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, state (last kept {after}), keepState, and for tests: connect, connection, sleep
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  const connection = handlers.connection ?? readFileSync(own.connection_fd, "utf8").trim();
  const client = await (handlers.connect ?? connectWithPg)(connection);
  let state = handlers.state?.after !== undefined ? handlers.state : { after: null };
  let wake = () => {};
  client.on?.("notification", (message) => { if (message.channel === own.channel) wake(); });
  try {
    await client.query(`LISTEN ${own.channel}`);
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
      }
      if (rows.length === own.most_per_read && !refused) continue;
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, own.look_again_ms);
        wake = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener("abort", wake, { once: true });
      });
      wake = () => {};
    }
  } finally {
    await keepState(state).catch(() => {});
    await client.end?.().catch?.(() => {});
  }
}
