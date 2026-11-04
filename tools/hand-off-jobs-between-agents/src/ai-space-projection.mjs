// Canonical bounded AI-to-Space convergence, shared by native and existing owners.
export const aiProjectionOf = ai => ({ ai_id: ai.id, name: ai.label, can: ai.can ?? [], live: { seen_at: ai.live?.seen_at ?? null, minutes: ai.live?.minutes ?? null, trouble: ai.live?.trouble ?? null } });
const IN_SPACE = 'in space';

export const AI_SPACE_PROJECTION_TABLE = 'ai_space_projection_pending';

export function initAiSpaceProjectionQueue(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${AI_SPACE_PROJECTION_TABLE} (
    ai_id TEXT PRIMARY KEY CHECK(ai_id LIKE 'ai:%'), desired TEXT, generation INTEGER NOT NULL, attempts INTEGER NOT NULL,
    next_at_ms INTEGER NOT NULL, after_holder TEXT, last_error TEXT
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ai_space_projection_due ON ${AI_SPACE_PROJECTION_TABLE} (next_at_ms, ai_id)`);
}

/** Durable, post-commit convergence for ordinary AI writes. The queue row is kept by PersonStore's in-transaction
 * written callback; network work happens only from the scheduler after that transaction commits. */
export function aiSpaceProjectionQueue({ sql, eeaf, person, now = () => Date.now() }) {
  // Only a confirmed empty queue is remembered. AI writes invalidate it before touching SQL (including writes that
  // later roll back); nonempty deadlines always come from the durable indexed row, never an in-memory time cache.
  let knownEmpty = false;
  const readPage = (limit = 10) => sql.exec(`SELECT ai_id, desired, generation, attempts, next_at_ms, after_holder, last_error
    FROM ${AI_SPACE_PROJECTION_TABLE} WHERE next_at_ms <= ? ORDER BY next_at_ms, ai_id LIMIT ?`, now(), limit).toArray();
  const queue = changed => {
    for (const record of changed) {
      // The stable ai:<key> identity can be tombstoned or moved to another record type. In either case, clear
      // any space copy that depended on it; a still-current AI record gets the latest projection.
      if (!record.id?.startsWith('ai:')) continue;
      knownEmpty = false;
      const current = eeaf.read(record.id);
      const desired = record.type === 'ai' && current ? {
        id: record.id, label: current.label, can: current.can ?? [],
        live: { seen_at: current.live?.seen_at ?? null, minutes: current.live?.minutes ?? null, trouble: current.live?.trouble ?? null },
      } : null;
      const packed = desired === null ? null : JSON.stringify(desired);
      sql.exec(`INSERT INTO ${AI_SPACE_PROJECTION_TABLE} (ai_id, desired, generation, attempts, next_at_ms, after_holder, last_error)
        VALUES (?, ?, 1, 0, ?, NULL, NULL)
        ON CONFLICT(ai_id) DO UPDATE SET desired = excluded.desired, generation = ${AI_SPACE_PROJECTION_TABLE}.generation + 1,
          attempts = 0, next_at_ms = excluded.next_at_ms, after_holder = NULL, last_error = NULL
        WHERE ${AI_SPACE_PROJECTION_TABLE}.desired IS NOT excluded.desired`, record.id, packed, now());
    }
  };
  const runDue = async (stage = {}) => {
    const started = now();
    let settled = 0;
    let remaining = true;
    const rows = stage.ai_id?sql.exec(`SELECT ai_id, desired, generation, attempts, next_at_ms, after_holder, last_error FROM ${AI_SPACE_PROJECTION_TABLE} WHERE ai_id=? AND next_at_ms<=? LIMIT 1`,stage.ai_id,now()).toArray():readPage(10);
    for (const row of rows) {
      let after = row.after_holder;
      let failed = false;
      const desired = row.desired === null ? null : JSON.parse(row.desired);
      while (!failed && now() - started < (stage.budget_ms ?? 1500)) {
        const page = eeaf.holdersOf(row.ai_id, { role: 'subject', ...(after ? { after } : {}), limit: 25 });
        if (page.complete === false) {
          // Earlier retained relations may appear before this cursor as the model is rebuilt. Keep the update
          // and restart its bounded walk after that owner is complete; an empty partial index proves no absence.
          sql.exec(`UPDATE ${AI_SPACE_PROJECTION_TABLE} SET next_at_ms = ?, after_holder = NULL, last_error = ? WHERE ai_id = ? AND generation = ?`, now() + 5_000, 'Space memberships are still loading.', row.ai_id, row.generation);
          failed = true;
          break;
        }
        const holders = page.holders ?? [];
        if (!holders.length) {
          sql.exec(`DELETE FROM ${AI_SPACE_PROJECTION_TABLE} WHERE ai_id = ? AND generation = ?`, row.ai_id, row.generation);
          settled += 1;
          break;
        }
        let processed = 0;
        for (const holder of holders) {
          const relation = eeaf.read(holder.id);
          const relationId = holder.id;
          if (relation?.role === IN_SPACE && String(relation.object).startsWith('space:')) {
            const space_id = relation.object.slice('space:'.length);
            try {
              const result = await person.network().spaceAgents({ relay: person.relay(), space_id, verb: desired ? 'project' : 'withdraw', input: desired
                ? { agent_id: row.ai_id.slice(row.ai_id.indexOf(':') + 1), ...aiProjectionOf(desired) }
                : { agent_id: row.ai_id.slice(row.ai_id.indexOf(':') + 1) } });
              if (desired && result?.projected === false) throw new Error('The space did not update this AI.');
              const fresh = sql.exec(`SELECT generation FROM ${AI_SPACE_PROJECTION_TABLE} WHERE ai_id = ?`, row.ai_id).toArray()[0];
              if (!fresh || fresh.generation !== row.generation) { failed = true;break; }
              if (!desired) eeaf.write([{ id: relationId, type: 'relation', value: null }], { actor: { by: 'ai-space-projection' }, unwatched: true });
            } catch (error) {
              const attempts = row.attempts + 1;
              const delay = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 10)));
              sql.exec(`UPDATE ${AI_SPACE_PROJECTION_TABLE} SET attempts = ?, next_at_ms = ?, after_holder = ?, last_error = ? WHERE ai_id = ? AND generation = ?`, attempts, now() + delay, after, 'Space AI update failed.', row.ai_id, row.generation);
              failed = true;
              break;
            }
          }
          after = holder.id;
          sql.exec(`UPDATE ${AI_SPACE_PROJECTION_TABLE} SET after_holder = ?, next_at_ms = ? WHERE ai_id = ? AND generation = ?`, after, now(), row.ai_id, row.generation);
          const current = sql.exec(`SELECT generation FROM ${AI_SPACE_PROJECTION_TABLE} WHERE ai_id = ?`, row.ai_id).toArray()[0];
          if (!current || current.generation !== row.generation) { failed = true; break; }
          processed += 1;
          if (now() - started >= (stage.budget_ms ?? 1500)) break;
        }
        if (failed) break;
        if (processed < holders.length) break;
        const nextAfter = page.next ?? page.next_after ?? (holders.length === 25 ? after : null);
        if (!nextAfter) {
          sql.exec(`DELETE FROM ${AI_SPACE_PROJECTION_TABLE} WHERE ai_id = ? AND generation = ?`, row.ai_id, row.generation);
          settled += 1;
          break;
        }
        after = nextAfter;
        if (now() - started >= (stage.budget_ms ?? 1500)) break;
      }
    }
    remaining = sql.exec(`SELECT ai_id FROM ${AI_SPACE_PROJECTION_TABLE} ORDER BY next_at_ms, ai_id LIMIT 1`).toArray().length > 0;
    return { settled, remaining };
  };
  const nextAt = () => {
    if (knownEmpty) return null;
    const at = sql.exec(`SELECT next_at_ms AS at FROM ${AI_SPACE_PROJECTION_TABLE} ORDER BY next_at_ms, ai_id LIMIT 1`).toArray()[0]?.at ?? null;
    knownEmpty = at === null;
    return at;
  };
  return { queue, nextAt, runDue };
}

