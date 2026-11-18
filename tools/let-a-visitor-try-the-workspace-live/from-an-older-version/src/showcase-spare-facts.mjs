// src/showcase-spare-facts.mjs
//
// PURPOSE
//   How far a live showcase's spare account is prepared, and who holds it, kept in that account's own records
//   (RecordBook showcaseFact, keepShowcaseFact, holdShowcaseFact; src/showcases.mjs is the only reader and writer): a
//   spare is prepared by one request at a time and handed to exactly one visitor. These are not the account's rights.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the names src/showcases.json `spare_facts` lists are kept here.
//   2. One holder at a time for a name: hold answers true to the caller that now holds it and false while another
//      does; a hold ends `ms` after it was taken, or never when `ms` is null. One call is one synchronous step of the
//      book, so two callers asking at once get one true between them.
//
//   showcaseSpareFacts(sql) → { fact(name) → value | null, keep(name, value), hold(name, holder, ms, now) → boolean }
import settings from '../../../showcases/src/showcases.json' with { type: 'json' };

const TABLE = 'own_showcase_facts';
const NAMES = new Set(settings.spare_facts);

export function showcaseSpareFacts(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  const named = name => { if (!NAMES.has(name)) throw Object.assign(new Error('That is not a showcase spare fact.'), { status: 400 }); return name; };
  const fact = name => { const row = sql.exec(`SELECT value FROM ${TABLE} WHERE name = ?`, named(name)).toArray()[0]; return row ? JSON.parse(row.value) : null; };
  const keep = (name, value) => {
    if (value === null || value === undefined) sql.exec(`DELETE FROM ${TABLE} WHERE name = ?`, named(name));
    else sql.exec(`INSERT INTO ${TABLE} (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`, named(name), JSON.stringify(value));
    return value ?? null;
  };
  return {
    fact,
    keep,
    hold(name, holder, ms, now) {
      if (typeof holder !== 'string' || !holder || (ms !== null && !Number.isFinite(ms))) throw Object.assign(new Error('A hold names its holder and how long it lasts.'), { status: 400 });
      const held = fact(name);
      if (held && held.holder !== holder && (held.until == null || held.until > now)) return false;
      keep(name, { holder, until: ms == null ? null : now + ms });
      return true;
    },
  };
}
