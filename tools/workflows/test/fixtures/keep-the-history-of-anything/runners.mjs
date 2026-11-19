// tools/workflows/test/fixtures/keep-the-history-of-anything/runners.mjs
//
// Two runners that answer the prove attempts of workflow:keep-the-history-of-anything (its prove step) through the two
// example renderings beside this file: one for a server database, one for an embedded one. A runner speaks one store's
// own language; the attempts and their answers name no store. The embedded rendering answers keeping, linking, spans,
// retraction, repeats and as-known reads; a runner that cannot answer an attempt answers none after it in that field.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const name = ([source, told]) => `${source}/${told}`;

/** Run one field's attempts on a runner; answers one value per attempt (null for config). */
export async function runField(runner, attempts) {
  const answers = [];
  let skipped = null;
  for (const attempt of attempts) {
    // A runner that cannot answer an attempt leaves its store behind the sequence, so it answers none after it.
    if (skipped || !runner.can(attempt.op)) { skipped ??= attempt.op; answers.push({ not_run: attempt.op, after: skipped }); continue; }
    answers.push(await runner[attempt.op](attempt));
  }
  return answers;
}

// ---- one runner per rendering ---------------------------------------------------------------------------------------

export async function postgresRunner(PGlite, renderingSql) {
  const db = new PGlite();
  await db.exec(renderingSql);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const idOf = async ([source, told]) => Number((await q('SELECT id FROM statements WHERE source = $1 AND told = $2', [source, told]))[0]?.id ?? 0);
  const recordedOf = async (key) => (await q('SELECT recorded_at::text AS t FROM statements WHERE source = $1 AND told = $2', key))[0].t;
  const named = async (ids) => {
    const rows = await q('SELECT id, source, told FROM statements WHERE id = ANY($1)', [ids]);
    const by = new Map(rows.map((r) => [Number(r.id), `${r.source}/${r.told}`]));
    return ids.map((id) => by.get(Number(id)));
  };
  const path = (p) => `$.${p.join('.')}`;
  const pause = () => new Promise((r) => setTimeout(r, 3));
  const runner = {
    db, q,
    can: () => true,
    async config(a) {
      for (const r of a.schemes ?? []) await db.query('INSERT INTO schemes (scheme, fold_case, most_things, told_about) VALUES ($1, $2, $3, $4)', [r.scheme, r.fold_case ?? false, r.most_things ?? null, r.told_about ?? false]);
      for (const r of a.meanings ?? []) await db.query('INSERT INTO meanings (meaning, joins_from, joins_to, tell_after) VALUES ($1, $2, $3, $4)', [r.meaning, r.joins_from ?? null, r.joins_to ?? null, r.tell_after_seconds === undefined ? null : `${r.tell_after_seconds} seconds`]);
      for (const r of a.meaning_rules ?? []) await db.query('INSERT INTO meaning_rules (position, source, place, change, path, meaning) VALUES ($1, $2, $3, $4, $5, $6)',
        [r.position, r.source ?? null, r.place ?? null, r.change ?? null, r.path ? (r.equals === undefined ? path(r.path) : `$.${r.path.slice(0, -1).join('.')} ? (@.${r.path.at(-1)} == ${JSON.stringify(r.equals)})`) : null, r.meaning]);
      for (const r of a.tell_words ?? []) await db.query('INSERT INTO tell_words VALUES ($1, $2, $3)', [r.position, r.all_of, r.words]);
      for (const r of a.mention_rules ?? []) await db.query('INSERT INTO mention_rules (source, place, path, role, scheme) VALUES ($1, $2, $3, $4, $5)', [r.source ?? null, r.place ?? null, path(r.path), r.role, r.scheme]);
      return null;
    },
    async tell(a) {
      await pause();
      try {
        const retracts = a.retracts ? await idOf(a.retracts) : null;
        const { rows } = await db.query(`INSERT INTO statements (source, told, place, change, at, key, after, meaning, retracts, holds_from, holds_until)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (source, told) DO NOTHING RETURNING id`,
          [a.source, a.told, a.place ?? null, a.change ?? null, a.at, a.key ?? null, a.after ? JSON.stringify(a.after) : null, a.meaning ?? null, retracts, a.holds_from ?? null, a.holds_until ?? null]);
        if (!rows.length) return 'same';
        for (const [role, scheme, value] of a.mentions ?? []) await db.query('INSERT INTO mentions VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [rows[0].id, role, scheme, value]);
        return 'kept';
      } catch { return 'refused'; }
    },
    async meaning(a) { return (await q('SELECT meaning FROM statements WHERE source = $1 AND told = $2', a.of))[0].meaning; },
    async history(a) {
      const known = a.known_after ? await recordedOf(a.known_after) : 'infinity';
      const rows = await q('SELECT id, stands FROM history($1, $2, $3)', [...a.thing, known]);
      const names = await named(rows.map((r) => r.id));
      return rows.map((r, i) => (r.stands ? names[i] : `${names[i]} (undone)`));
    },
    async things(a) { return (await q("SELECT scheme || ' ' || value AS t FROM things_of($1, $2, $3) ORDER BY 1", [...a.id, a.at])).map((r) => r.t); },
    async too_shared(a) { return (await q("SELECT scheme || ' ' || value || ' ' || things AS t FROM too_shared($1) ORDER BY 1", [a.at])).map((r) => r.t); },
    async due_tells(a) {
      const now = new Date(new Date(await recordedOf(a.after)).getTime() + a.plus_seconds * 1000).toISOString();
      return (await q("SELECT thing_scheme || ' ' || thing_value AS thing, meanings, words FROM due_tells($1) ORDER BY 1", [now]));
    },
    async tell_made(a) {
      const now = new Date(new Date(await recordedOf(a.after)).getTime() + a.plus_seconds * 1000).toISOString();
      const { rows } = await db.query(`INSERT INTO tells (thing_scheme, thing_value, through, words)
        SELECT thing_scheme, thing_value, through, words FROM due_tells($1) WHERE thing_scheme = $2 AND thing_value = $3
        ON CONFLICT DO NOTHING RETURNING through`, [now, ...a.thing]);
      return rows.length ? 'made' : 'nothing due';
    },
    async erase(a) { return Number((await q('SELECT erase($1, $2) AS n', a.thing))[0].n); },
  };
  return runner;
}

// The embedded rendering answers the keeping, linking, spans, retraction, dedupe and as-known reads; the rest of the
// attempts (things, sharing reports, what is due to be told, erasure) are answered by the server rendering only, and say so.
export function embeddedRunner(DatabaseSync, renderingSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(renderingSql);
  const HISTORY = `
WITH RECURSIVE reach (scheme, value, lo, hi) AS (
  SELECT :scheme, :value, '0000', '9999'
  UNION
  SELECT f.scheme, f.value, max(r.lo, coalesce(s.holds_from, '0000')), min(r.hi, coalesce(s.holds_until, '9999'))
  FROM reach r
  JOIN mentions t ON t.scheme = r.scheme AND t.value = r.value
  JOIN statements s ON s.id = t.statement AND s.recorded_at <= :known AND s.retracts IS NULL AND s.erased_at IS NULL
  JOIN meanings m ON m.meaning = s.meaning AND m.joins_to = t.role
  JOIN mentions f ON f.statement = s.id AND f.role = m.joins_from
  WHERE NOT EXISTS (SELECT 1 FROM statements x WHERE x.retracts = s.id AND x.recorded_at <= :known)
    AND max(r.lo, coalesce(s.holds_from, '0000')) < min(r.hi, coalesce(s.holds_until, '9999'))),
shown AS (
  SELECT DISTINCT s.id, s.at, s.recorded_at FROM reach r JOIN mentions m ON m.scheme = r.scheme AND m.value = r.value
  JOIN statements s ON s.id = m.statement AND s.recorded_at <= :known AND s.at >= r.lo AND s.at < r.hi)
SELECT p.id, p.source || '/' || p.told AS name, NOT EXISTS (SELECT 1 FROM statements x WHERE x.retracts = p.id AND x.recorded_at <= :known) AS stands
FROM (SELECT * FROM shown UNION SELECT s.id, s.at, s.recorded_at FROM statements s WHERE s.retracts IN (SELECT id FROM shown) AND s.recorded_at <= :known) q
JOIN statements p ON p.id = q.id ORDER BY q.at, q.recorded_at, q.id`;
  const pause = () => { const until = Date.now() + 3; while (Date.now() < until); };
  const ops = new Set(['config', 'tell', 'meaning', 'history']);
  return {
    can: (op) => ops.has(op),
    config(a) {
      for (const r of a.schemes ?? []) db.prepare('INSERT INTO schemes (scheme, fold_case, most_things) VALUES (?, ?, ?)').run(r.scheme, r.fold_case ? 1 : 0, r.most_things ?? null);
      for (const r of a.meanings ?? []) db.prepare('INSERT INTO meanings (meaning, joins_from, joins_to) VALUES (?, ?, ?)').run(r.meaning, r.joins_from ?? null, r.joins_to ?? null);
      for (const r of a.meaning_rules ?? []) db.prepare('INSERT INTO meaning_rules (position, source, place, change, path, equals, meaning) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.position, r.source ?? null, r.place ?? null, r.change ?? null, r.path ? `$.${r.path.join('.')}` : null, r.equals ?? null, r.meaning);
      for (const r of a.mention_rules ?? []) db.prepare('INSERT INTO mention_rules VALUES (?, ?, ?, ?, ?)').run(r.source ?? null, r.place ?? null, `$.${r.path.join('.')}`, r.role, r.scheme);
      return null;
    },
    tell(a) {
      pause();
      try {
        const retracts = a.retracts ? db.prepare('SELECT id FROM statements WHERE source = ? AND told = ?').get(...a.retracts)?.id ?? null : null;
        const { changes, lastInsertRowid } = db.prepare(`INSERT OR IGNORE INTO statements (source, told, place, change, at, key, after, meaning, retracts, holds_from, holds_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.source, a.told, a.place ?? null, a.change ?? null, a.at, a.key ?? null, a.after ? JSON.stringify(a.after) : null, a.meaning ?? null, retracts, a.holds_from ?? null, a.holds_until ?? null);
        if (!changes) return 'same';
        for (const [role, scheme, value] of a.mentions ?? []) db.prepare('INSERT OR IGNORE INTO mentions VALUES (?, ?, ?, ?)').run(lastInsertRowid, role, scheme, value);
        return 'kept';
      } catch { return 'refused'; }
    },
    meaning(a) { return db.prepare('SELECT meaning FROM statements WHERE source = ? AND told = ?').get(...a.of).meaning; },
    history(a) {
      const known = a.known_after ? db.prepare('SELECT recorded_at FROM statements WHERE source = ? AND told = ?').get(...a.known_after).recorded_at : '9999';
      return db.prepare(HISTORY).all({ scheme: a.thing[0], value: a.thing[1], known }).map((r) => (r.stands ? r.name : `${r.name} (undone)`));
    },
  };
}
