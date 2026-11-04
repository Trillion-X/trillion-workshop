// src/outside-readings.mjs
//
// Purpose: what an outside service last answered, kept, so whatever shows it (a screen, a widget, a board piece, an
// AI) reads the kept answer and never makes the service be asked synchronously. Each source row says how to read it
// and how often (every_minutes); this store's alarm reads the due ones, and a read whose answer equals the kept one
// writes nothing. Every kept answer carries when it was read, so a surface can say "read 4 min ago".
//
// Why it exists: on 2026-10-05 every look at Spend ran Cloudflare's and Fly's tools again, so each widget, board piece
// and AI call multiplied provider reads and the tool runs they write. A cache window on one screen (reuse an answer
// younger than 15 minutes) fixed one surface; this fixes every reading for every surface: the read happens on the
// source's own cadence and nowhere else.
//
// NON-NEGOTIABLE INVARIANTS
//   1. latest() never reads a source. A source nobody has read yet is asked for (onAsk arms the alarm) and answers null;
//      a stale kept answer is still shown with its original read time while onAsk re-arms its overdue refresh.
//   2. A read whose answer equals the kept one writes nothing; only the time it was seen is held in memory.
//   3. A source names its period by `since`: a kept answer for another `since` (yesterday's day) is not this one's, and
//      is read again at once.
//   4. An answer the consumer does not keep (keep(answer) false, such as "not connected") is held in memory for one
//      cadence and is never scheduled again until a reader asks for it after that, even when an older period remains
//      stored under the same source id.
//   5. Nothing here names a service, a reading or a consumer: sources are rows the consumer hands in.
//   6. A change notice from a service (a webhook delivery) reads a source now through readNow(id); nothing else does.
//
// Shapes
//   outsideReadings({ get(id) -> kept | null, set(id, kept), onAsk?(), now?, most_per_wake? }) -> {
//     latest(source) -> { answer, read_at } | null
//     nextAt(sources) -> ms | null
//     refresh(sources, { read(source) -> Promise<answer>, keep?(answer) -> boolean }) -> Promise<changed ids>
//     readNow(id)
//   }
//   source: { id, since?, every_minutes }          kept: { answer, since, read_at, changed_at } (ISO times)
//

const MINUTE = 60_000;
const iso = ms => new Date(ms).toISOString();
const sinceOf = source => source.since ?? null;

export function outsideReadings({ get, set, onAsk = () => {}, now = () => Date.now(), most_per_wake = 4 }) {
  // Reads that wrote nothing: an unchanged answer's time, or an answer that is not kept (with its answer).
  const seen = new Map();
  // Sources a reader found unread, read first on the next wake.
  const asked = new Set();
  const keptOf = source => { const kept = get(source.id); return kept && kept.since === sinceOf(source) ? kept : null; };
  const ask = id => { if (asked.has(id)) return; asked.add(id); onAsk(); };
  const dueAt = source => {
    if (asked.has(source.id)) return now();
    // A read for a new period can be refused because its source is disconnected. That observation is not kept, but it
    // still suppresses another immediate read for this same period. Consult it before the prior-period kept value.
    const observed = seen.get(source.id);
    if (observed?.since === sinceOf(source) && 'answer' in observed)
      return null;
    const stored = get(source.id);
    if (!stored) return null;
    if (stored.since !== sinceOf(source)) return now();
    const last = Math.max(Date.parse(stored.read_at), seen.get(source.id)?.at ?? 0);
    return last + source.every_minutes * MINUTE;
  };

  return {
    latest(source) {
      const held = seen.get(source.id);
      // An answer not kept holds for one cadence; after it a reader asks again (a service connected since then).
      if (held && 'answer' in held && held.since === sinceOf(source) && held.at + source.every_minutes * MINUTE > now()) return { answer: held.answer, read_at: iso(held.at) };
      const kept = keptOf(source);
      if (!kept) { ask(source.id); return null; }
      // A sleeping or backed-up alarm must not leave an old provider value looking current forever. A look retains the
      // last answer and its source time, but asks the existing alarm to read any overdue source once.
      if (dueAt(source) <= now()) ask(source.id);
      return { answer: kept.answer, read_at: iso(Math.max(Date.parse(kept.read_at), held?.at ?? 0)) };
    },
    nextAt(sources) {
      const times = sources.map(dueAt).filter(ms => ms !== null);
      return times.length ? Math.min(...times) : null;
    },
    async refresh(sources, { read, keep = () => true }) {
      const at = now();
      const due = sources.filter(source => { const ms = dueAt(source); return ms !== null && ms <= at; }).slice(0, most_per_wake);
      const changed = [];
      for (const source of due) {
        const answer = await read(source);
        asked.delete(source.id);
        const since = sinceOf(source);
        if (!keep(answer)) { seen.set(source.id, { at: now(), since, answer }); continue; }
        const kept = keptOf(source);
        if (kept && JSON.stringify(kept.answer) === JSON.stringify(answer)) { seen.set(source.id, { at: now(), since }); continue; }
        set(source.id, { answer, since, read_at: iso(now()), changed_at: iso(now()) });
        seen.delete(source.id);
        changed.push(source.id);
      }
      return changed;
    },
    readNow(id) { ask(id); },
  };
}

// Shared SQL realization; each host invokes it at its original lazy boundary.
export function setupOutsideReadingsTable(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS outside_readings (id TEXT PRIMARY KEY, kept TEXT NOT NULL)');
  return sql;
}
