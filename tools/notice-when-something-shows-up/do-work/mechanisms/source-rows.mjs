/**
 * notice-when-something-shows-up/do-work/mechanisms/source-rows.mjs
 *
 * Purpose
 *   One waiting mechanism for many lists a service keeps: the lists are rows of a table in the person's database, each
 *   with its own settings (a service-lists waiter's request and shape), its own kept fingerprints, the time it was read
 *   and the time it is due again. One waiter, one session, watches every row: each pass reads the rows that are due, in
 *   due order, reads each one's list once (service-lists.mjs `readList`), tells each thing that differs from its kept
 *   fingerprints (`compare`) and writes the row back with its new fingerprints and its next due time. Adding a list is
 *   adding a row; it takes no switch, no wake copy and no session of its own. Nov 21 2026, 5:3x PM CST: a waiter per
 *   source in one switch's input held every slot the Mac had for seven creator channels, and 1,343 more could not be added.
 *
 * Non-negotiable invariants
 *   - It names no service and no table of the person's: the table is a setting, each row's request and shape are the
 *     row's own, and one credential (the waiter's own credential_name) is placed only in the request headers a row names.
 *   - A row is read only when it is due (`due_at` empty or past), oldest due first, at most `most_reads_per_minute` reads
 *     a minute: the capacity of one session is measured in reads a minute, never in slots.
 *   - A row's fingerprints move only past what was told: a tell the engine refused leaves the row's fingerprints where the
 *     last told thing left them and makes it due again soon (`again_after_refusal_seconds`), so nothing is skipped; each
 *     change is told under its own event key, so telling it again is one fact.
 *   - A list that cannot be read is said on its row (`last_said`) and read again at its next due time; it never stops the
 *     other rows or the session.
 *   - What reads cost is capped each day: no read starts once what today's reads cost (each row's `cost`, else
 *     `cost.per_read`) would pass the day's cap. The cap is the person's budget row when it exists (`cost.budget_table`,
 *     `cost.budget_id`, its `daily_cost`), else what the service says is left today (`cost.balance_request` and
 *     `cost.balance_path`, read once a day with the same credential): never a number written here.
 *   - It writes only its own rows' kept columns (seen, read_at, due_at, last_said). Its login needs to read and update
 *     the table (and read the budget table, when one is named).
 *
 * The table (made by the person's own AI; its columns are this contract)
 *   id text primary key, settings jsonb (a service-lists waiter's mechanism_settings, without its credential),
 *   is_active boolean, cost numeric (null: cost.per_read), seen jsonb (null: never read), read_at timestamptz,
 *   due_at timestamptz (null: due now), last_said text, list_group text (which waiter reads it: one waiter per credential,
 *   so lists read with one service's key and lists read with another's share the table).
 *
 * Settings (mechanism_settings)
 *   connection_fd           the descriptor holding the database's connection string (default 4)
 *   credential_fd           the descriptor holding the service's credential when the waiter names none (default 5)
 *   table                   the table of lists (a plain name)
 *   list_group              the rows this waiter reads (their list_group); left out, every row
 *   most_per_pass           the most due rows one pass takes (default 50)
 *   most_reads_per_minute   the most lists read a minute (default 60)
 *   longest_wait_seconds    the longest a pass waits before looking at the table again (default 60), so a row added or
 *                           made due by hand is read within it
 *   again_after_refusal_seconds  how soon a row whose tell was refused is read again (default 30)
 *   cost                    { per_read?, budget_table?, budget_id?, balance_request?: {url, headers}, balance_path? }
 */
import { compare, readList, readSettings as readListSettings, at } from "./service-lists.mjs";
import { readGivenCredential } from "./given-credential.mjs";
import { clientOptions, crashed } from "./row-changes.mjs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::source-rows";
const NAME = /^[a-z_][a-z0-9_]*$/;

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "before", "after", "kinds"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const cost = settings.cost ?? {};
  return {
    connection_fd: Number.isInteger(Number(settings.connection_fd)) ? Number(settings.connection_fd) : 4,
    credential_fd: Number.isInteger(Number(settings.credential_fd)) ? Number(settings.credential_fd) : 5,
    table: typeof settings.table === "string" && NAME.test(settings.table) ? settings.table : null,
    list_group: typeof settings.list_group === "string" && settings.list_group !== "" ? settings.list_group : null,
    most_per_pass: number(settings.most_per_pass, 50),
    most_reads_per_minute: number(settings.most_reads_per_minute, 60),
    longest_wait_ms: number(settings.longest_wait_seconds, 60) * 1000,
    again_after_refusal_ms: number(settings.again_after_refusal_seconds, 30) * 1000,
    cost: {
      per_read: Number.isFinite(Number(cost.per_read)) && Number(cost.per_read) >= 0 ? Number(cost.per_read) : 0,
      budget_table: typeof cost.budget_table === "string" && NAME.test(cost.budget_table) ? cost.budget_table : null,
      budget_id: typeof cost.budget_id === "string" ? cost.budget_id : null,
      balance_request: cost.balance_request?.url ? cost.balance_request : null,
      balance_path: typeof cost.balance_path === "string" ? cost.balance_path : null,
    },
  };
}

/** The table of lists over a Postgres client: the rows due now, one row written back, the next due time, the budget. */
export function pgStore(client, own) {
  const table = own.table;
  return {
    async due(limit, nowMs) {
      const { rows } = await client.query(`SELECT id, settings, cost, seen, read_at FROM ${table}
        WHERE is_active AND (due_at IS NULL OR due_at <= $1) AND ($3::text IS NULL OR list_group = $3)
        ORDER BY due_at NULLS FIRST, id LIMIT $2`, [new Date(nowMs), limit, own.list_group]);
      return rows.map((row) => ({ ...row, read_at: row.read_at ? new Date(row.read_at).getTime() : null }));
    },
    async save(id, { seen, read_at, due_at, last_said }) {
      await client.query(`UPDATE ${table} SET seen = $2, read_at = $3, due_at = $4, last_said = $5 WHERE id = $1`,
        [id, seen === undefined ? null : JSON.stringify(seen), read_at === null ? null : new Date(read_at), new Date(due_at), last_said ?? null]);
    },
    async nextDue() {
      const { rows } = await client.query(`SELECT min(coalesce(due_at, 'epoch'::timestamptz)) AS next FROM ${table}
        WHERE is_active AND ($1::text IS NULL OR list_group = $1)`, [own.list_group]);
      const next = rows?.[0]?.next;
      return next ? new Date(next).getTime() : null;
    },
    async budget() {
      if (!own.cost.budget_table || !own.cost.budget_id) return null;
      try {
        const { rows } = await client.query(`SELECT daily_cost FROM ${own.cost.budget_table} WHERE id = $1`, [own.cost.budget_id]);
        const value = Number(rows?.[0]?.daily_cost);
        return rows?.length && Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
  };
}

async function connectWithPg(connection) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(await clientOptions(connection));
  await client.connect();
  return client;
}

/** What the service says is left today (`cost.balance_request`, `cost.balance_path`), or null when it says nothing usable. */
export async function readBalance(own, credential, fetchImpl = fetch) {
  const request = own.cost.balance_request;
  if (!request || !own.cost.balance_path) return null;
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name, String(value).replaceAll("{credential}", credential)]));
  const response = await fetchImpl(request.url, { method: request.method ?? "GET", headers });
  if (!response.ok) return null;
  const value = Number(at(await response.json(), own.cost.balance_path));
  return Number.isFinite(value) ? value : null;
}

/** The day a time is in, as the cap counts it (UTC). */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Read each due list, tell what changed, and write its row back, until stopped.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, state ({day, spent, cap}), keepState, credentialFd, credentialMounted,
 *   and for tests: store, credential, fetch, now, sleep
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  if (!own.table) throw Object.assign(new Error("This waiter names no table of lists (mechanism_settings.table)."), { reason: "no-table" });
  const signal = handlers.signal;
  const now = () => handlers.now?.() ?? Date.now();
  const keepState = handlers.keepState ?? (async () => {});
  const fetchImpl = handlers.fetch ?? fetch;
  const credential = handlers.credential ?? readGivenCredential(handlers, own.credential_fd);
  const sleep = handlers.sleep ?? ((ms) => new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  let client = null;
  let store = handlers.store ?? null;
  if (!store) {
    // Read once through given-credential, which keeps each descriptor's text: a mounted credential answers only its first read.
    const connection = handlers.connection ?? readGivenCredential({ credentialFd: own.connection_fd }, own.connection_fd);
    try {
      client = await (handlers.connect ?? connectWithPg)(connection);
    } catch (error) {
      throw crashed(error, `source-rows could not connect to ${own.table}`);
    }
    store = pgStore(client, own);
  }
  // Today's spend and cap, kept with the waiter so a restart does not spend the day again.
  let spend = handlers.state?.day ? { ...handlers.state } : { day: null, spent: 0, cap: null };
  const readTimes = [];
  /** The cap of the day `today`: the budget row when there is one, else what the service says is left at the day's start. */
  async function capOf(today) {
    const budget = await store.budget();
    if (budget !== null) return budget;
    if (spend.day === today && spend.cap !== null) return spend.cap;
    return readBalance(own, credential, fetchImpl).catch(() => null);
  }
  try {
    while (!signal?.aborted) {
      const today = dayOf(now());
      if (spend.day !== today) spend = { day: today, spent: 0, cap: null };
      spend.cap = await capOf(today);
      await keepState(spend);
      const rows = await store.due(own.most_per_pass, now());
      let read = 0;
      let capped = false;
      for (const row of rows) {
        if (signal?.aborted) return;
        const cost = Number.isFinite(Number(row.cost)) && row.cost !== null ? Number(row.cost) : own.cost.per_read;
        if (cost > 0 && (spend.cap === null || spend.spent + cost > spend.cap)) { capped = true; break; }
        // At most most_reads_per_minute reads in any minute.
        while (readTimes.length >= own.most_reads_per_minute && now() - readTimes[0] < 60_000) {
          await sleep(60_000 - (now() - readTimes[0]));
          if (signal?.aborted) return;
        }
        readTimes.push(now());
        while (readTimes.length > own.most_reads_per_minute) readTimes.shift();
        spend.spent += cost;
        await keepState(spend);
        await readOne(row);
        read += 1;
      }
      if (signal?.aborted) return;
      if (read === own.most_per_pass && !capped) continue;
      // Wait for the next row due, a day's new cap, or longest_wait, whichever comes first.
      const next = capped ? null : await store.nextDue();
      const wait = next === null ? own.longest_wait_ms : Math.min(Math.max(next - now(), 0), own.longest_wait_ms);
      await sleep(wait);
    }
  } finally {
    await keepState(spend).catch(() => {});
    await client?.end?.().catch?.(() => {});
  }

  /** Read one row's list, tell what differs from its kept fingerprints, and write the row back. */
  async function readOne(row) {
    const listOwn = readListSettings(row.settings ?? {});
    const readAt = new Date(now());
    let found;
    try {
      found = await readList(listOwn, credential, fetchImpl);
    } catch (error) {
      await store.save(row.id, { seen: row.seen ?? undefined, read_at: row.read_at, due_at: now() + listOwn.look_again_ms, last_said: String(error?.message ?? error).slice(0, 500) });
      return;
    }
    if (row.seen === null || row.seen === undefined) {
      if (!listOwn.tell_what_is_there_at_first) {
        const { now: seen } = compare({ own: listOwn, seen: {}, items: found.items, whole: false, readAt });
        await store.save(row.id, { seen, read_at: readAt.getTime(), due_at: now() + listOwn.look_again_ms, last_said: null });
        return;
      }
    }
    const seen = { ...(row.seen ?? {}) };
    const { changes } = compare({ own: listOwn, seen, items: found.items, whole: found.whole, readAt });
    let refused = false;
    for (const one of changes) {
      const told = await handlers.onTransition({
        condition: "became-reachable",
        observed_identity: { where: listOwn.where, place: one.detail.place },
        event_key: `${listOwn.where}:${one.detail.place}:${one.key}:${one.detail.change}:${one.print ?? one.detail.at}`,
        detail: one.detail,
      });
      if (told === false) { refused = true; break; }
      if (one.print === null) delete seen[one.key]; else seen[one.key] = one.print;
    }
    await store.save(row.id, { seen, read_at: readAt.getTime(), due_at: now() + (refused ? own.again_after_refusal_ms : listOwn.look_again_ms),
      last_said: refused ? "the engine did not take a change; it is told again at the next read" : null });
  }
}
