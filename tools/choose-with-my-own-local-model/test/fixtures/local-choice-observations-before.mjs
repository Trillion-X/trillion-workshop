// One account's bounded, input-free observations of local choice requests.
// The caller owns its input and answer. This owner only records whether an
// eligible route answered inside its deadline, so coverage cannot be inferred
// from an AI chat that did not actually call it.
export const CHOICE_OBSERVATION_LIMIT = 2000;

export function localChoiceObservations(sql, { now = () => Date.now(), limit = CHOICE_OBSERVATION_LIMIT } = {}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS local_choice_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    task TEXT NOT NULL,
    surface TEXT NOT NULL,
    outcome TEXT NOT NULL,
    model TEXT,
    elapsed_ms INTEGER NOT NULL,
    reason TEXT
  )`);
  const observe = ({ task, surface, outcome, model = null, elapsed_ms, reason = null }) => {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(task) || !/^[a-z][a-z0-9-]{0,79}$/.test(surface)) throw new Error('A task and surface id are required.');
    if (!['answered', 'unavailable', 'timeout', 'refused', 'error'].includes(outcome)) throw new Error('Unknown choice outcome.');
    sql.exec('INSERT INTO local_choice_observations (at, task, surface, outcome, model, elapsed_ms, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      new Date(now()).toISOString(), task, surface, outcome, model, Math.max(0, Math.round(Number(elapsed_ms) || 0)), reason);
    sql.exec('DELETE FROM local_choice_observations WHERE seq NOT IN (SELECT seq FROM local_choice_observations ORDER BY seq DESC LIMIT ?)', limit);
  };
  const run = async ({ task, surface, decide, model = null, deadline_ms }) => {
    const started = now();
    const wait = Math.max(1, Math.round(Number(deadline_ms) || 1));
    let timer;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(decide),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('choice deadline exceeded')), wait); }),
      ]);
      const outcome = answer === null || answer === undefined ? 'unavailable' : 'answered';
      observe({ task, surface, outcome, model: answer?.served_by ?? answer?.model ?? model, elapsed_ms: now() - started });
      return answer;
    } catch (error) {
      const outcome = error?.message === 'choice deadline exceeded' ? 'timeout' : 'error';
      observe({ task, surface, outcome, model, elapsed_ms: now() - started, reason: outcome === 'timeout' ? 'deadline' : 'route-error' });
      if (outcome === 'timeout') return null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const summary = () => {
    const rows = sql.exec('SELECT at, task, surface, outcome, model, elapsed_ms FROM local_choice_observations ORDER BY seq DESC LIMIT ?', limit).toArray();
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.task}\0${row.surface}`;
      if (!groups.has(key)) groups.set(key, { task: row.task, surface: row.surface, requests: 0, answers: 0, unavailable: 0, timeouts: 0, refused: 0, errors: 0, p95_answer_ms: null, models: {}, answer_times: [] });
      const group = groups.get(key);
      group.requests += 1;
      if (row.outcome === 'answered') { group.answers += 1; group.answer_times.push(row.elapsed_ms); }
      else if (row.outcome === 'timeout') group.timeouts += 1;
      else if (row.outcome === 'refused') group.refused += 1;
      else if (row.outcome === 'error') group.errors += 1;
      else group.unavailable += 1;
      if (row.model) group.models[row.model] = (group.models[row.model] ?? 0) + 1;
    }
    const coverage = [...groups.values()].map(({ answer_times, ...group }) => ({ ...group,
      p95_answer_ms: answer_times.length ? answer_times.sort((a, b) => a - b)[Math.ceil(answer_times.length * 0.95) - 1] : null }));
    return { source: 'local_choice_observations', window: rows.length, oldest_at: rows.at(-1)?.at ?? null,
      newest_at: rows[0]?.at ?? null, coverage };
  };
  return { observe, run, summary };
}

export const localChoiceTools = call => [{ name: 'read_local_choice_coverage',
  description: 'Shows only observed choice calls from this account: tasks and surfaces reached, answers, unavailable routes, timeouts, errors and p95 answer time in the bounded observation window. Closed AI chats with no call are not counted.',
  inputSchema: { type: 'object', properties: {} }, run: () => call('/local-choices/coverage', {}) }];
export const localChoiceAnnotations = { read_local_choice_coverage: { title: 'Read local choice coverage', readOnlyHint: true, destructiveHint: false, idempotentHint: true } };
