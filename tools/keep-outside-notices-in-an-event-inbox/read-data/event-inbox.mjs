// src/event-inbox.mjs
//
// Purpose: the inbox an outside service's notices are kept in before anything acts on them: one Durable Object per
// notice (noticeInboxName, by the source's own event id) and one per source for its upkeep (upkeepInboxName), so no
// inbox every notice shares stands in the way (payments used one object, 'payments', for every notice). A notice is kept the moment it arrives and the sender is answered at once; the
// inbox then applies it through the handler its source names (src/inbox-handlers.mjs `apply`) and, while the handler cannot
// finish (a store busy, a service down), tries again later, sooner at first and then at most once an hour, until it
// lands. So a notice is never lost to a busy store and never depends on one person's store being up when it arrives.
//
// Invariants:
// - One row per notice key (the source's own event id): a notice delivered again is the same row, applied once.
// - A handler answer below 300 is done; 400, 404 and 409 mean the notice is not one to apply (refused, kept with why);
//   anything else, or a throw, is tried again. Handlers are idempotent, so trying again never applies twice.
// - The alarm is always set while a notice waits, so waiting work is never left without a next try (L223).
// - A notice that lands makes its source's waiting notices due at once: one may have been waiting on it. Each waiting
//   notice is listed in the edge store (APP_KV `inbox-waiting:{source}:{key}`, gone once it lands or is refused), so the
//   one that lands can wake the others in their own objects (WAKE_MOST at a time).
// - Upkeep runs only in the object a source's upkeep is addressed to (tend marks it there); an older object holding
//   an upkeep row it was never asked for here lets it go at its next alarm.
// - A source may also name upkeep (`tend`: for payments, keeping Stripe's prices in step with the offer rows), run at
//   most once an hour when asked (tend) and kept running hourly by the alarm once asked, whatever store is busy.
import { noticeInboxName } from '../../name-event-inboxes/src/event-inbox-names.mjs';

const TEND_EVERY_MS = 60 * 60 * 1000;
const FIRST_WAIT_MS = 3 * 1000;
const LONGEST_WAIT_MS = 60 * 60 * 1000;
const APPLY_WITHIN_MS = 90 * 1000;
const PER_ALARM = 10;
const REFUSED = new Set([400, 404, 409]);
const WAKE_MOST = 20;
const WAITING = 'inbox-waiting:';


export class EventInbox {
  // The current host owns durable storage, alarms, admitted handlers and route
  // membership. No retired StoredObject engine or global payment handler loads.
  constructor(ctx, env, { inboxHandlers, routeMembership } = {}) {
    if (!ctx?.storage?.sql || !inboxHandlers?.apply || !inboxHandlers?.tend)
      throw Object.assign(new Error('The durable event host and admitted handlers are unavailable.'), { code: 'event_host_unavailable', status: 503 });
    this.ctx = ctx; this.env = env; this.inboxHandlers = inboxHandlers; this.routeMembership = routeMembership;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notices (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, body TEXT NOT NULL, header TEXT NOT NULL, origin TEXT NOT NULL,
      received_at INTEGER NOT NULL, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
      said TEXT, done_at INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS notices_waiting ON notices (state, next_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS upkeep (source TEXT PRIMARY KEY, origin TEXT NOT NULL, ran_at INTEGER, said TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS upkeep_owned (source TEXT PRIMARY KEY)');
  }

  membership() {
    if (!this.routeMembership) throw Object.assign(new Error('The admitted route membership owner is unavailable.'), { code: 'event_route_owner_unavailable', status: 503 });
    return this.routeMembership;
  }

  // Internal binding calls only. Event routes use dedicated object names, separate from notice-processing inboxes.
  changeEventRoute(input) { return this.membership().change(input); }

  async eventRouteStores({ source_id, route_key }) {
    const legacy = JSON.parse((await this.env.APP_KV.get(`event-route:${source_id}:${route_key}`)) ?? '[]');
    // Read SQL after the asynchronous legacy lookup, so a stop that finished during that lookup remains final.
    return this.membership().list(legacy);
  }

  /** Keeps one notice and answers at once: { state } of its row ('waiting' for a new one). */
  async take({ source, key, body, header, origin }) {
    if (!this.inboxHandlers.apply[source]) throw new Error(`No handler applies notices from ${source}.`);
    const now = Date.now();
    this.sql.exec('INSERT OR IGNORE INTO notices (key, source, body, header, origin, received_at, state, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key, source, body, header, origin, now, 'waiting', now);
    const row = this.sql.exec('SELECT state FROM notices WHERE key = ?', key).toArray()[0];
    if (row.state === 'waiting') {
      await this.env?.APP_KV?.put(`${WAITING}${source}:${key}`, String(now), { expirationTtl: 30 * 86400 });
      await this.wake(now);
    }
    return { state: row.state };
  }

  /** Another notice of the source landed: whatever waits here is due now. */
  async nudge() {
    const now = Date.now();
    this.sql.exec("UPDATE notices SET next_at = ? WHERE state = 'waiting' AND next_at > ?", now, now);
    if (this.sql.exec("SELECT 1 FROM notices WHERE state = 'waiting' LIMIT 1").toArray().length) await this.wake(now);
  }

  /** The newest notices with where each stands, for whoever looks after this inbox. */
  async notices({ limit = 50, state = null } = {}) {
    const rows = state
      ? this.sql.exec('SELECT key, source, received_at, state, tries, next_at, said, done_at FROM notices WHERE state = ? ORDER BY received_at DESC LIMIT ?', state, limit).toArray()
      : this.sql.exec('SELECT key, source, received_at, state, tries, next_at, said, done_at FROM notices ORDER BY received_at DESC LIMIT ?', limit).toArray();
    const counts = Object.fromEntries(this.sql.exec('SELECT state, COUNT(*) AS n FROM notices GROUP BY state').toArray().map(row => [row.state, row.n]));
    return { counts, notices: rows };
  }

  /** Runs the source's upkeep now unless it ran within the hour, and keeps it running hourly: { ran, said }. */
  async tend({ source, origin }) {
    if (!this.inboxHandlers.tend[source]) throw new Error(`${source} has no upkeep.`);
    const kept = this.sql.exec('SELECT ran_at, said FROM upkeep WHERE source = ?', source).toArray()[0];
    this.sql.exec('INSERT INTO upkeep (source, origin) VALUES (?, ?) ON CONFLICT (source) DO UPDATE SET origin = excluded.origin', source, origin);
    this.sql.exec('INSERT OR IGNORE INTO upkeep_owned (source) VALUES (?)', source);
    if (kept?.ran_at && Date.now() - kept.ran_at < TEND_EVERY_MS) return { ran: false, said: kept.said };
    return { ran: true, said: await this.upkeep(source, origin) };
  }

  async upkeep(source, origin) {
    let said;
    try { said = JSON.stringify(await this.inboxHandlers.tend[source](this.env, origin)).slice(0, 2000); }
    catch (error) { said = `failed: ${String(error?.message ?? error).slice(0, 500)}`; }
    this.sql.exec('UPDATE upkeep SET ran_at = ?, said = ? WHERE source = ?', Date.now(), said, source);
    console.log(JSON.stringify({ inbox_upkeep: { source, said } }));
    await this.wake(Date.now() + TEND_EVERY_MS);
    return said;
  }

  async wake(at) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const now = Date.now();
    const due = this.sql.exec("SELECT * FROM notices WHERE state = 'waiting' AND next_at <= ? ORDER BY next_at LIMIT ?", now, PER_ALARM).toArray();
    for (const row of due) await this.apply(row);
    this.sql.exec('DELETE FROM upkeep WHERE source NOT IN (SELECT source FROM upkeep_owned)');
    for (const job of this.sql.exec('SELECT source, origin, ran_at FROM upkeep').toArray()) {
      if (!job.ran_at || now - job.ran_at >= TEND_EVERY_MS) await this.upkeep(job.source, job.origin);
    }
    const waiting = this.sql.exec("SELECT MIN(next_at) AS at FROM notices WHERE state = 'waiting'").toArray()[0]?.at;
    const tended = this.sql.exec('SELECT MIN(ran_at) AS at FROM upkeep').toArray()[0]?.at;
    const next = Math.min(waiting ?? Infinity, tended != null ? tended + TEND_EVERY_MS : Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  async apply(row) {
    let status = 0;
    let said = null;
    let timeout;
    try {
      const answer = await Promise.race([
        this.inboxHandlers.apply[row.source](this.env, { body: row.body, header: row.header, origin: row.origin }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`no answer in ${APPLY_WITHIN_MS / 1000} s`)), APPLY_WITHIN_MS); }),
      ]);
      status = answer.status;
      said = (await answer.text()).slice(0, 500);
    } catch (error) {
      said = String(error?.message ?? error).slice(0, 500);
    } finally { clearTimeout(timeout); }
    const tries = row.tries + 1;
    const now = Date.now();
    if (status >= 200 && status < 300) {
      this.sql.exec("UPDATE notices SET state = 'done', tries = ?, said = ?, done_at = ? WHERE key = ?", tries, said, now, row.key);
      // A notice that lands can be what another was waiting on (a purchase's subscription notice arriving before its
      // checkout notice names the buyer), so the source's waiting notices are tried again at once, not after their wait.
      this.sql.exec("UPDATE notices SET next_at = ? WHERE source = ? AND state = 'waiting' AND next_at > ?", now, row.source, now);
      await this.settled(row);
      await this.wakeWaiting(row.source);
    }
    else if (REFUSED.has(status)) {
      this.sql.exec("UPDATE notices SET state = 'refused', tries = ?, said = ?, done_at = ? WHERE key = ?", tries, said, now, row.key);
      await this.settled(row);
    }
    else {
      const wait = Math.min(FIRST_WAIT_MS * 2 ** Math.min(row.tries, 12), LONGEST_WAIT_MS);
      this.sql.exec('UPDATE notices SET tries = ?, said = ?, next_at = ? WHERE key = ?', tries, said, now + wait, row.key);
      console.error(JSON.stringify({ inbox_notice_waiting: { key: row.key, tries, status, said } }));
    }
  }

  async settled(row) { await this.env?.APP_KV?.delete(`${WAITING}${row.source}:${row.key}`).catch(() => null); }

  // The source's other waiting notices, each in its own object, are made due now (at most WAKE_MOST, in key order).
  async wakeWaiting(source) {
    const kv = this.env?.APP_KV, inboxes = this.env?.EVENT_INBOX;
    if (!kv?.list || !inboxes) return;
    const listed = await kv.list({ prefix: `${WAITING}${source}:`, limit: WAKE_MOST }).catch(() => ({ keys: [] }));
    for (const { name } of listed.keys) {
      const key = name.slice(`${WAITING}${source}:`.length);
      await inboxes.get(inboxes.idFromName(noticeInboxName(key))).nudge().catch(() => null);
    }
  }
}
