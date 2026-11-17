// Read only the timing fields of older handoffs for the own-AI clock. Job words and
// results can be many kilobytes each; the clock never needs them. A fixed SQL page
// keeps each cursor bounded while old rows still share the record-backed owner.
import { scheduledHandoffOf } from './agents.mjs';

const PAGE = 100;
const FIELDS = {
  state: '$.state', to_agent: '$.to_agent', taken_by: '$.taken_by', priority: '$.priority',
  source_id: '$.input.arrived.source_id', in_the_way: '$.in_the_way',
  blocked_kind: '$.blocked_kind', hold_until: '$.hold_until', generation: '$.generation',
  depth: '$.input.arrived.depth', chat_first_minutes: '$.input.arrived.chat_first_minutes',
  in_the_way_by: '$.in_the_way_by', in_the_way_at: '$.in_the_way_at', prefer_until: '$.target.prefer_until',
};

export function scheduledHandoffsPageFromTable(sql, { after = null, afterRowid = 0, limit = PAGE, shadows = () => false } = {}) {
  const present = new Set(sql.exec('PRAGMA table_info(agent_handoffs)').toArray().map(column => column.name));
  const field = name => {
    const fromValue = `json_extract(value, '${FIELDS[name]}')`;
    return present.has(name) ? `COALESCE(${name}, ${fromValue}) AS ${name}` : `${fromValue} AS ${name}`;
  };
  const selected = Object.keys(FIELDS).map(field).join(', ');
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : PAGE;
  if (!size) return [];
  const answer = [];
  let mark = after;
  for (;;) {
    const requested = Math.min(PAGE, size - answer.length);
    const page = sql.exec(`SELECT rowid, handoff_id, handed_at, ${selected} FROM agent_handoffs
      WHERE open = 1 AND rowid > ?
      ${mark ? 'AND (handed_at, handoff_id) > (?, ?)' : ''}
      ORDER BY handed_at, handoff_id LIMIT ?`, afterRowid,
    ...(mark ? [mark.handed_at, mark.handoff_id] : []), requested).toArray();
    for (const row of page) if (!shadows(row.handoff_id)) answer.push(scheduledHandoffOf(row, row));
    if (answer.length >= size || page.length < requested) return answer.slice(0, size);
    mark = page.at(-1);
  }
}

// The keep-running clock asks for the first few of the person's own unheld jobs.
// Select their ids and times before reading any words; a large backlog belonging
// to other agents is never copied into JavaScript to answer this question.
export function ownWorkFromTable(sql, { nowIso, before = null, minPriority, limit = 1,
  afterRowid = 0, shadows = () => false, includeSaid = false } = {}) {
  const present = new Set(sql.exec('PRAGMA table_info(agent_handoffs)').toArray().map(column => column.name));
  const field = name => present.has(name)
    ? `COALESCE(${name}, json_extract(value, '${FIELDS[name]}'))`
    : `json_extract(value, '${FIELDS[name]}')`;
  const answer = [];
  let mark = null;
  while (answer.length < limit) {
    const page = sql.exec(`SELECT handoff_id, handed_at FROM agent_handoffs WHERE open = 1 AND rowid > ?
      AND COALESCE(${field('priority')}, 0) >= ?
      AND (${field('taken_by')} IS NULL OR ${field('hold_until')} IS NULL OR ${field('hold_until')} < ?)
      ${before ? 'AND handed_at < ?' : ''}
      ${mark ? 'AND (handed_at, handoff_id) > (?, ?)' : ''}
      ORDER BY handed_at, handoff_id LIMIT ?`, afterRowid, minPriority, nowIso,
      ...(before ? [before] : []), ...(mark ? [mark.handed_at, mark.handoff_id] : []), PAGE).toArray();
    for (const row of page) {
      if (!shadows(row.handoff_id)) answer.push({ handoff_id: row.handoff_id, handed_at: row.handed_at });
      if (answer.length >= limit) break;
    }
    if (page.length < PAGE) break;
    mark = page.at(-1);
  }
  if (!includeSaid) return answer;
  return answer.map(row => ({ ...row, said: sql.exec(
    "SELECT json_extract(value, '$.said') AS said FROM agent_handoffs WHERE handoff_id = ?", row.handoff_id,
  ).toArray()[0]?.said ?? null }));
}
