// tools/notice-when-something-shows-up/do-work/kept-places.mjs
//
// Where each waiter's place is kept: its last fact and its mechanism's state (a row-changes waiter's last told
// {txid, position}, a service-lists waiter's fingerprints of what it has seen), under the waiter's kept key (`keptKeyOf`:
// the wake that started the run, its waiter ref and its address). One store per run, chosen by the run's input:
//
// Each wake keeps its own places (Nov 25 2026, 3:07 AM CST). The key was the waiter ref and address alone
// ("waiter:row-changes@where::something-changed"), the same for every copy of a wake (keep-noticing-row-changes and its
// copies, one per pursuit database, run one waiter, each over its own database): on one computer every
// copy kept one place in the kept folder (one folder per account and tool), and with places_in two copies that name one
// database refused each other, and four databases were each given the same carried-in place. So the key starts with the
// wake's own id, which the engine hands each run in its task (`cause.wake`, the copy id `<declared id>/<name>` for a
// copy; trillion-rust src/wake.rs, the cause it hands the runner; the row's argv gives it as `--wake`):
// "keep-noticing-row-changes/notes|waiter:row-changes@where::something-changed". A run that no wake started (a direct
// tools:run) has no wake, and keeps under the key without one, as before.
//
// Carrying over from the key without a wake (the shared key), once: a wake's first read of a key of its own that no
// store holds yet starts from the shared key's place, and that first read keeps it under the wake's key at once (the
// database's first row, a file in the kept folder), so the wake never reads the shared key again. A place is read in
// this order: the wake's own key in the database, the shared key in the database, the wake's own key in the kept folder,
// the shared key in the kept folder (a place in the database wins over one in the kept folder, and within each store
// the wake's own wins over the shared one). A row-changes place is a (txid, position) and txids are counted across one
// Postgres server, so a copy that starts from another database's place on the same server goes on from that point in
// the server's order of transactions.
//
// The shared key is never written, claimed or removed by a wake's run: it is only read, so every copy that ran before
// keys named the wake can still carry over from it, in any order, on any computer. A wake switched on for the first time
// later finds it too, and starts from that place instead of from now; it stops moving once no run without a wake keeps
// it, so once every copy has a key of its own (`SELECT kept_as FROM kept_waiter_places WHERE kept_as LIKE '%|' || <shared
// key>`, and in the kept folder a file per copy), the shared row or file is removed by its owner, and wakes switched on
// after that start from now.
//
// - With no `places_in`, the kept folder (`folderPlaces`): one file per kept key in the row's `invoke.kept_folder`, which
//   the engine gives once per account and tool on each computer (trillion-rust src/tool_runs/tools/container.rs
//   `kept_folder`). This is how every waiter kept its place before places_in, unchanged.
// - With `places_in` (the vault name of a database of the person's, mounted on PLACES_FD by the row's credential_mounts),
//   that database's PLACES_TABLE (`databasePlaces`): one row per tool and kept key, so the place belongs to the person and
//   the tool, not to a computer, and a wake moved to another computer goes on from where the last computer stopped.
//
// Why (Nov 25 2026, 1:50 AM CST): keep-noticing wakes were moved from the Mac to another computer by wake:switch. The
// other computer's kept folder still held a place from before Nov 22, so its row-changes waiter told again days of
// changes the Mac had already told. An event key is admitted once only inside one computer's wake book, so the engine
// started each of them again.
//
// Rules of the database store:
// - A run claims a place when it first reads it: the row's version moves on and names this run (kept_on, kept_by_run).
//   Every later write is compare-and-set on the version this run holds. So when two runs keep one waiter's place at
//   once (one wake on two computers), the run that started last holds it, and the other's next write is refused
//   (`placeTaken`), saying which run holds the place, on which computer and since when. Nothing moves the place twice
//   without it being said. The refused run's waiter tells nothing more (tell-the-engine.mjs writeRecord asks `taken`
//   before it tells) and ends with that refusal as its fact (emit-arrival-fact.mjs runResidentEmitter). Two copies of one
//   wake are two wakes with two keys, so they never hold one place and never refuse each other.
// - A place in the database wins over a place in this computer's kept folder. The kept folder is read only for a kept
//   key the database holds no row for (the first run that names places_in carries its folder's place into the
//   database), and it is never written while places_in is named: one store holds each place.
// - The table is made once, by the first run that finds it missing (PLACES_SETUP_SQL, CREATE TABLE IF NOT EXISTS). A
//   table with a trigger of its own (a tell_row_change trigger) is refused before anything is kept: a row-changes
//   waiter that watches the same database would tell each place move as a change, and each telling moves the place
//   again.
// - A store that cannot be read or written is no empty place: its error is a crash (`crash`), so the waiter is started
//   again instead of starting from now and passing over what changed meanwhile.
//
// The run reaches only the hosts every key it holds may go to (trillion-rust src/tool_runs/tools/network.rs
// `fence_to`): places_in has to name a database whose key may go to the hosts the waiters' own keys go to (every
// pursuit database is kept on one server), or the engine refuses the run (tools_tool_keys_share_no_host).
//
// AI Assistant Directive: the extensive documentation in this codebase is a critical design feature. You are forbidden
// from simplifying or removing it. Maintain and extend this detail.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectWithPg } from './mechanisms/postgres-connection.mjs';

/** The descriptor the run holds places_in's connection on: the last one the engine hands a process
 *  (trillion-rust src/tool_runs.rs HELD_DESCRIPTORS, 3..=63), so it never meets credential_name's 4 or a waiter's 5 + its
 *  place in the list; an input with a credential for a waiter at place 58 is refused by the engine as two mounts on one
 *  descriptor. */
export const PLACES_FD = 63;

/** The table each place is kept in, in the database places_in names. */
export const PLACES_TABLE = 'kept_waiter_places';

/** The one statement that makes PLACES_TABLE: the tool and the waiter's kept key name a place; place is the kept value
 *  ({payload, state}, null while a run has claimed it and kept nothing yet); version moves on with every claim and write;
 *  kept_at, kept_on (the computer's host name as the run sees it) and kept_by_run say who moved it last. */
export const PLACES_SETUP_SQL = `CREATE TABLE IF NOT EXISTS ${PLACES_TABLE} (
  tool text NOT NULL,
  kept_as text NOT NULL,
  place jsonb,
  version bigint NOT NULL,
  kept_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kept_on text NOT NULL,
  kept_by_run text NOT NULL,
  PRIMARY KEY (tool, kept_as))`;

const READ_SQL = `SELECT place, version::text AS version FROM ${PLACES_TABLE} WHERE tool = $1 AND kept_as = $2`;
const CLAIM_SQL = `UPDATE ${PLACES_TABLE} SET version = version + 1, kept_at = clock_timestamp(), kept_on = $4, kept_by_run = $5
  WHERE tool = $1 AND kept_as = $2 AND version = $3::bigint RETURNING version::text AS version`;
const FIRST_SQL = `INSERT INTO ${PLACES_TABLE} (tool, kept_as, place, version, kept_on, kept_by_run) VALUES ($1, $2, $3::jsonb, 1, $4, $5)
  ON CONFLICT (tool, kept_as) DO NOTHING RETURNING version::text AS version`;
const WRITE_SQL = `UPDATE ${PLACES_TABLE} SET place = $3::jsonb, version = version + 1, kept_at = clock_timestamp(), kept_on = $5, kept_by_run = $6
  WHERE tool = $1 AND kept_as = $2 AND version = $4::bigint RETURNING version::text AS version`;
const HOLDER_SQL = `SELECT version::text AS version, kept_at, kept_on, kept_by_run FROM ${PLACES_TABLE} WHERE tool = $1 AND kept_as = $2`;
/** How many times a claim is tried while other runs move the same place between its read and its claim. */
const MOST_CLAIMS = 5;

/** What parts the wake from the rest of a kept key. No wake id holds it (a copy's name is lowercase letters, digits and
 *  hyphens, trillion-rust src/wake.rs `copied`), so a key with a wake is never taken for one without. */
export const WAKE_SEPARATOR = '|';

/** The key one waiter's place is kept under (`as`) and the key it carries over from once (`carriedFrom`, null for none):
 *  the waiter ref and the address it emits at (two waiters that emit at one address keep apart), after the wake that
 *  started the run (`wake`, null for a run no wake started, which keeps under the shared key itself). */
export function keptKeyOf({ wake = null, waiterRef = null, addressLabel }) {
  const shared = typeof waiterRef === 'string' && waiterRef !== '' ? `${waiterRef}@${addressLabel}` : addressLabel;
  if (typeof wake !== 'string' || wake === '') return { as: shared, carriedFrom: null };
  return { as: `${wake}${WAKE_SEPARATOR}${shared}`, carriedFrom: shared };
}

/** The places of one kept folder (`folder`, null for none: kept in memory for this run alone, by the carrier). Each kept
 *  key is one file, its name the key as base64url, written whole (a new file renamed over the old). */
export function folderPlaces(folder) {
  const fileOf = keptAs => path.join(folder, `${Buffer.from(keptAs).toString('base64url')}.json`);
  const readFile = (keptAs) => {
    if (folder === null || keptAs === null) return null;
    try {
      return JSON.parse(readFileSync(fileOf(keptAs), 'utf8'));
    } catch {
      return null;
    }
  };
  const writeFile = (keptAs, value) => {
    if (folder === null) return;
    mkdirSync(folder, { recursive: true });
    const file = fileOf(keptAs);
    writeFileSync(`${file}.new`, JSON.stringify(value));
    renameSync(`${file}.new`, file);
  };
  return {
    kind: 'kept-folder',
    /** The place of `keptAs`, else the place of `carriedFrom`, writing nothing: what a database store carries in. */
    peek(keptAs, carriedFrom = null) {
      return readFile(keptAs) ?? readFile(carriedFrom);
    },
    /** The place of `keptAs`. With none, the place of `carriedFrom` is carried over and kept under `keptAs` at once, so
     *  it is carried once. */
    async read(keptAs, carriedFrom = null) {
      const own = readFile(keptAs);
      if (own !== null) return own;
      const carried = readFile(carriedFrom);
      if (carried !== null) writeFile(keptAs, carried);
      return carried;
    },
    async write(keptAs, value) {
      writeFile(keptAs, value);
    },
    taken() { return null; },
    async close() {},
  };
}

/** The error a write to a place another run holds is refused with: who holds it, where and since when. */
export function placeTaken(keptAs, holder, where) {
  const by = holder ? `run ${holder.kept_by_run} on ${holder.kept_on} since ${new Date(holder.kept_at).toISOString()} (version ${holder.version})` : 'no run: its row was removed';
  return Object.assign(new Error(`the place of ${keptAs} in ${where} is held by ${by}; this run keeps it no longer and tells nothing more for it`), {
    placeTaken: true, reason: 'place-kept-elsewhere', keptAs, holder: holder ?? null });
}

/** A failed read or write of the place store, as a crash: the waiter is started again, never started from now. */
function unreachable(error, where) {
  return Object.assign(new Error(`the places in ${where} could not be read or written: ${error?.message ?? error}`, { cause: error }), {
    crash: true, reason: 'places-unreachable' });
}

/** The places of one tool (`tool`) in a database (`client`: {query(sql, params) -> {rows}}, already holding
 *  PLACES_TABLE), named `where` in what it says. `keptOn` and `run` name this run in every row it moves. `fallback` is the
 *  kept folder's store, read only for a kept key the database holds no row for, and never written. */
export function databasePlaces({ client, tool, where, keptOn, run, fallback = folderPlaces(null) }) {
  /** The version this run holds of each place it claimed. */
  const held = new Map();
  /** Each place another run took from this one, as the refusal its writes get. */
  const taken = new Map();
  let broken = null;
  client.on?.('error', (error) => { broken = error; });
  const query = async (sql, params) => {
    if (broken) throw unreachable(broken, where);
    try {
      return (await client.query(sql, params)).rows ?? [];
    } catch (error) {
      throw unreachable(error, where);
    }
  };
  /** Claims the place of `keptAs` for this run and answers its value: the database's, or, with no row, the first place
   *  carried in, in the order the header gives: the database's row of `carriedFrom` (only read, never claimed, so every
   *  copy can carry over from it), then the kept folder's own key and its `carriedFrom`. The first row made holds what was
   *  carried in, so it is carried once. Another run that moves the place between the read and the claim makes the claim
   *  read again. */
  async function claim(keptAs, carriedFrom = null) {
    for (let tries = 0; tries < MOST_CLAIMS; tries += 1) {
      const [row] = await query(READ_SQL, [tool, keptAs]);
      if (row) {
        const [claimed] = await query(CLAIM_SQL, [tool, keptAs, row.version, keptOn, run]);
        if (claimed) {
          held.set(keptAs, claimed.version);
          return row.place ?? null;
        }
        continue;
      }
      const [shared] = carriedFrom === null ? [] : await query(READ_SQL, [tool, carriedFrom]);
      const carried = shared?.place ?? fallback.peek(keptAs, carriedFrom);
      const [first] = await query(FIRST_SQL, [tool, keptAs, carried === null ? null : JSON.stringify(carried), keptOn, run]);
      if (first) {
        held.set(keptAs, first.version);
        return carried;
      }
    }
    throw unreachable(new Error(`its place moved under ${MOST_CLAIMS} claims in a row`), where);
  }
  return {
    kind: 'database',
    async read(keptAs, carriedFrom = null) {
      return claim(keptAs, carriedFrom);
    },
    async write(keptAs, value) {
      if (taken.has(keptAs)) throw taken.get(keptAs);
      if (!held.has(keptAs)) await claim(keptAs);
      const [written] = await query(WRITE_SQL, [tool, keptAs, JSON.stringify(value), held.get(keptAs), keptOn, run]);
      if (written) {
        held.set(keptAs, written.version);
        return;
      }
      const [holder] = await query(HOLDER_SQL, [tool, keptAs]);
      const refusal = placeTaken(keptAs, holder, where);
      taken.set(keptAs, refusal);
      held.delete(keptAs);
      throw refusal;
    },
    taken(keptAs) { return taken.get(keptAs) ?? null; },
    async close() { await client.end?.(); },
  };
}

/** Makes PLACES_TABLE in the database `client` reaches when it is missing, and refuses one that has a trigger. */
export async function preparePlacesTable(client, where) {
  const [found] = (await client.query(`SELECT to_regclass('${PLACES_TABLE}') IS NOT NULL AS made`)).rows;
  if (!found?.made) await client.query(PLACES_SETUP_SQL);
  const [triggers] = (await client.query(`SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid = '${PLACES_TABLE}'::regclass AND NOT tgisinternal`)).rows;
  if (triggers?.count > 0) {
    throw new Error(`${PLACES_TABLE} in ${where} has a trigger of its own: a row-changes waiter would tell each place it keeps as a change, and each telling moves the place again. Drop the trigger, or name another database in places_in.`);
  }
}

/** The run's place store: the kept folder `keep` (null for none) when the input names no places_in, else places_in's
 *  database, reached with `connection` (the text on PLACES_FD), its table made when missing. `connect` is for tests. */
export async function placesFor({ placesIn = null, keep = null, connection = null, tool, keptOn, run, connect = connectWithPg }) {
  const fallback = folderPlaces(keep);
  if (placesIn === null) return fallback;
  let client;
  try {
    client = await connect(connection);
  } catch (error) {
    throw unreachable(error, placesIn);
  }
  // The store listens for the connection's own errors before the first statement, so a dropped connection is a crash it
  // says, never an unheard error event that ends the process with no words.
  const places = databasePlaces({ client, tool, where: placesIn, keptOn, run, fallback });
  await preparePlacesTable(client, placesIn);
  return places;
}
