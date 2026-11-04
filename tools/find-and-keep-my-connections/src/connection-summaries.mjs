// src/connection-summaries.mjs
//
// Purpose: one small row per connection (the row the connections listing shows: service, vendor, account name, status,
// can_send, connected_at, last_checked, connected_by), kept as the connection is written, so a listing reads one row a
// connection instead of the ~20 facts a connection is kept as plus the look-ups of its last check and who connected it.
// Every connections listing read those facts whole: the hold of what waits on the person read ~11.6k rows a call and
// GET /setup/runtime ~9.5k on the account owner's store (2026-10-07), and a store start read them again.
//
// Non-Negotiable Invariants:
//   1. Derived: every row can be rebuilt from the connection's own facts (src/held-values.mjs connectionFacts.one) and its
//      check and connected-by facts; nothing lives only here. The facts stay the truth.
//   2. Written in the same transaction as the writes that own the facts (the executor's `atomically`), by the executor that
//      writes them, for the connection those writes name; a row that did not change is not written again.
//   3. Connections kept before the rows are summarised once, by their own scheduler source (`fillStep`): at most
//      FILL_CONNECTIONS connections a wake, found one by one through the facts' own address order from a persisted cursor,
//      each read by its own address range. No question fills. Until the fill is finished a question answers from the
//      facts as it always did (the executor decides, `filled()`), so a store is never answered half.
//   4. A question reads only what it names: `rows()` one row a connection (the listing), `one(id)` one row, `needingYou()` the
//      disconnected rows and, for each of their services, one connected row of that service's family, `hasConnected(vendor)`
//      one index entry, `connectedVendors()` one index step a connected vendor. Nothing scans the table to answer a question
//      that names less.
//   5. Names no service and no field of one: a row is whatever the executor shows, kept as it was shown.
//

// How many connections one wake of the fill summarises.
export const FILL_CONNECTIONS = 25;
// The existing incident cap remains bounded while both incoming cursor protocols are supported.
export const CONNECTIONS_PAGE_DEFAULT = 100;
export const CONNECTIONS_PAGE_MAX = 100;

// A service's family: its vendor cut at the first ':' (`x:account-2` is in family `x`), as the waiting sections group it.
export const familyOf = vendor => String(vendor ?? '').split(':')[0];

/** The rows that need the person from a whole listing (the same answer `needingYou()` reads from the table): the disconnected
 *  ones, then for each of their families one connected row, so the sign-in section can leave out a service the person has
 *  connected under another account. */
export function needingYouOf(rows) {
  const needing = rows.filter(row => row.status === 'disconnected');
  const families = new Set(needing.map(row => familyOf(row.vendor)).filter(Boolean));
  return [...needing, ...[...families].map(family => rows.find(row => row.status === 'connected' && familyOf(row.vendor) === family)).filter(Boolean)];
}

export const connectedVendorsOf = rows => [...new Set(rows.filter(row => row.status === 'connected').map(row => row.vendor).filter(vendor => typeof vendor === 'string' && vendor))].sort();

/** The summaries over a person's store. → { filled(), put(id, row | null), rows(), one(id), needingYou(), connectedVendors(),
 *  hasConnected(vendor), fillStep: { nextAt(), step({ next, keep }) } } */
export function connectionSummaries(sql, { now = () => Date.now() } = {}) {
  sql.exec('CREATE TABLE IF NOT EXISTS connection_summaries (connection_id TEXT PRIMARY KEY, vendor TEXT NOT NULL, status TEXT NOT NULL, shown TEXT NOT NULL) WITHOUT ROWID');
  sql.exec('CREATE INDEX IF NOT EXISTS connection_summaries_status ON connection_summaries (status, vendor)');
  sql.exec('CREATE INDEX IF NOT EXISTS connection_summaries_vendor ON connection_summaries (vendor, connection_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS connection_summaries_state_page ON connection_summaries (status, connection_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS connection_summaries_filled (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT NOT NULL, done INTEGER NOT NULL)');

  let finished = false;
  const filled = () => {
    if (!finished) finished = Boolean(sql.exec('SELECT done FROM connection_summaries_filled WHERE id = 1 LIMIT 1').toArray()[0]?.done);
    return finished;
  };
  const shown = rows => rows.map(row => JSON.parse(row.shown));
  const connectedOf = family => {
    const exact = sql.exec("SELECT shown FROM connection_summaries WHERE status = 'connected' AND vendor = ? LIMIT 1", family).toArray();
    if (exact.length) return exact;
    // `family:` up to `family;` (the next character after ':') holds every vendor of the family and no other.
    return sql.exec("SELECT shown FROM connection_summaries WHERE status = 'connected' AND vendor >= ? AND vendor < ? LIMIT 1", `${family}:`, `${family};`).toArray();
  };

  const fillStep = {
    /** When the fill is next owed (now), or null once it is finished: the scheduler source's time. */
    nextAt: () => (filled() ? null : now()),
    /** At most FILL_CONNECTIONS connections of the fill: next(id) is the connection after `id` ('' for the first), null at the
     *  end; keep(id) writes that connection's row. → { done, summarised } */
    step({ next, keep }) {
      if (filled()) return { done: true, summarised: 0 };
      let after = sql.exec('SELECT after FROM connection_summaries_filled WHERE id = 1 LIMIT 1').toArray()[0]?.after ?? '';
      let summarised = 0, done = false;
      while (summarised < FILL_CONNECTIONS) {
        const id = next(after);
        if (id === null) { done = true; break; }
        keep(id);
        after = id;
        summarised += 1;
      }
      sql.exec('INSERT INTO connection_summaries_filled (id, after, done) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET after = excluded.after, done = excluded.done', after, done ? 1 : 0);
      return { done, summarised };
    },
  };

  return {
    fillStep,
    filled,
    /** The connection's row as the listing shows it (null: it has none, and any row kept is dropped). Not written when unchanged. */
    put(id, row) {
      if (!row) { sql.exec('DELETE FROM connection_summaries WHERE connection_id = ?', id); return; }
      sql.exec(`INSERT INTO connection_summaries (connection_id, vendor, status, shown) VALUES (?, ?, ?, ?)
        ON CONFLICT (connection_id) DO UPDATE SET vendor = excluded.vendor, status = excluded.status, shown = excluded.shown WHERE connection_summaries.shown IS NOT excluded.shown`,
      id, String(row.vendor ?? ''), String(row.status ?? ''), JSON.stringify(row));
    },
    /** Every connection's row, in connection order (one row read a connection). */
    rows() {
      const rows = [];
      let after = '';
      for (;;) {
        const page = shown(sql.exec('SELECT shown FROM connection_summaries WHERE connection_id > ? ORDER BY connection_id LIMIT 100', after).toArray());
        rows.push(...page);
        if (page.length < 100) return rows;
        after = page.at(-1).connection_id;
      }
    },
    page({ after = '', limit = 100 } = {}) {
      const rows = shown(sql.exec('SELECT shown FROM connection_summaries WHERE connection_id > ? ORDER BY connection_id LIMIT ?', after, limit + 1).toArray());
      return { rows: rows.slice(0, limit), connections: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].connection_id : null };
    },
    forVendors(vendors) {
      return [...new Set(vendors)].flatMap(vendor => {
        const rows = [];
        let after = '';
        for (;;) {
          const page = shown(sql.exec('SELECT shown FROM connection_summaries WHERE vendor = ? AND connection_id > ? ORDER BY connection_id LIMIT 100', String(vendor), after).toArray());
          rows.push(...page);
          if (page.length < 100) return rows;
          after = page.at(-1).connection_id;
        }
      });
    },
    ofVendors(vendors) { return this.forVendors(vendors).sort((a, b) => a.connection_id < b.connection_id ? -1 : a.connection_id > b.connection_id ? 1 : 0); },
    one(id) { return shown(sql.exec('SELECT shown FROM connection_summaries WHERE connection_id = ? LIMIT 1', id).toArray())[0] ?? null; },
    /** The disconnected rows, then one connected row of each of their families (see needingYouOf). */
    needingYou() {
      const needing = [];
      let after = '';
      for (;;) {
        const page = shown(sql.exec("SELECT shown FROM connection_summaries WHERE status = 'disconnected' AND connection_id > ? ORDER BY connection_id LIMIT 100", after).toArray());
        needing.push(...page);
        if (page.length < 100) break;
        after = page.at(-1).connection_id;
      }
      const families = new Set(needing.map(row => familyOf(row.vendor)).filter(Boolean));
      return [...needing, ...[...families].flatMap(family => shown(connectedOf(family)))];
    },
    /** Whether any connection of exactly this vendor is connected (one index entry). */
    connectedForVendors(vendors) { return [...new Set(vendors)].flatMap(vendor => shown(sql.exec("SELECT shown FROM connection_summaries WHERE status = 'connected' AND vendor = ? LIMIT 1", String(vendor)).toArray())); },
    hasConnected(vendor) { return sql.exec("SELECT 1 FROM connection_summaries WHERE status = 'connected' AND vendor = ? LIMIT 1", String(vendor)).toArray().length > 0; },
    /** The vendors with a connected connection, sorted: one index step a vendor, however many connections each has. */
    connectedVendors() {
      const vendors = [];
      let after = '';
      for (;;) {
        const page = sql.exec(`WITH RECURSIVE step(vendor) AS (
          SELECT MIN(vendor) FROM connection_summaries WHERE status = 'connected' AND vendor > ?
          UNION ALL SELECT (SELECT MIN(vendor) FROM connection_summaries WHERE status = 'connected' AND vendor > step.vendor) FROM step WHERE step.vendor IS NOT NULL)
        SELECT vendor FROM step WHERE vendor IS NOT NULL LIMIT 100`, after).toArray().map(row => row.vendor);
        vendors.push(...page);
        if (page.length < 100) return vendors;
        after = page.at(-1);
      }
    },
  };
}
