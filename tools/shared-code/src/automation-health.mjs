// src/automation-health.mjs
//
// Purpose: how each source that feeds a person's automations is doing, as the Workshop tool tool:read-source-health
// (placement:this-worker, records/workshop-engine-tool-records.json). A source is anything things arrive from: a
// carrier through the one door (src/inbound.mjs: a note app, voice memos, email), a connected account's events
// (src/events.mjs), a schedule. Its caller hands in, per source, what arrived (each arrival with its id, time and the
// fields that name it), the rules listening to it and every run those rules started, each tied to the arrival that
// started it and ended in a state; this counts arrivals over the periods in the looks file, says which rule and run the
// last arrival started and how each ended, says the last error in plain words and decides the source's state with the
// formula engine's row filter (tool:filter-rows-by-rules) over the states' own rules.
//
// Non-Negotiable Invariants:
//   1. Every state, its words and tone, the order they are tried in, the periods counted, how long each kind of source
//      may stay silent, what each run state counts as, which results mean a run worked and which is a failure, the words for a
//      source nothing has arrived from, which fields name an arrival, and the plain error words are DATA
//      (src/automation-health-looks.json). Nothing here names a state, a kind of source, a carrier or a service.
//   2. Nothing is kept: the answer is computed from what the caller read, every time. When the caller could not read
//      everything it counts (`or_more`: { arrivals: [period ids], runs: true }), the source shows it unchanged, so a
//      count is never taken for the whole when it is a floor.
//   3. A run whose state the looks file does not name counts as `run_result_otherwise`, never as a success.
//   4. A source's state is the first state whose rules hold for it; a state with no rules holds for every source.
//   5. Only failures after the newest run that worked count against a source: a run that finished, or one that started
//      and is still going (the arrival reached an AI), shows the road works again, so one old fault never keeps a busy
//      source failing while every later arrival is handed on.
//   6. A computer reader's current failure, stale report or settled item newer than the newest arrival is independent
//      of workflow runs: a successful workflow does not hide an item that never reached the one door.
//

const HOUR = 3600000;
const time = value => (typeof value === 'string' ? Date.parse(value) : NaN);
const known = value => Number.isFinite(value);
const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

/** The error's own words: a record kept as JSON ({ "error": "...", ... }) says them in its error field. */
function errorText(error) {
  if (typeof error !== 'string') return typeof error?.error === 'string' ? error.error : JSON.stringify(error ?? '');
  try {
    const read = JSON.parse(error);
    return typeof read?.error === 'string' ? read.error : error;
  } catch {
    return error;
  }
}

/** The words a person reads for an error: the first plain_errors row it contains, else the error itself, cut short. */
export function plainError(error, looks) {
  const text = errorText(error);
  const lower = text.toLowerCase();
  const row = looks.plain_errors.find(item => lower.includes(item.contains.toLowerCase()));
  return cut(row ? row.words : text.trim(), looks.error_words_most);
}

/**
 * looks:      src/automation-health-looks.json
 * filterRows: the formula engine's row filter ({ tree, fields, rows } → { matches }), as tool:filter-rows-by-rules runs it
 */
export function makeSourceHealth({ looks, filterRows }) {
  const runsPeriod = looks.periods.find(period => period.id === looks.runs_counted_over);
  const resultOf = state => looks.run_results[state] ?? looks.run_result_otherwise;
  const titleOf = arrival => {
    const field = looks.title_fields.find(name => typeof arrival[name] === 'string' && arrival[name].trim());
    return field ? cut(arrival[field].trim().split('\n')[0], looks.title_words_most) : null;
  };

  function facts(source, nowMs) {
    const kind = looks.kinds[source.kind] ?? {};
    const label = source.label ?? source.source_id;
    const rules = source.rules ?? [];
    const ruleLabel = id => rules.find(rule => rule.rule_id === id)?.label ?? id ?? null;
    const arrived = (source.arrived ?? []).map(item => ({ ...item, ms: time(item.at) })).filter(item => known(item.ms)).sort((a, b) => b.ms - a.ms);
    const last = arrived[0] ?? null;
    const arrivals = Object.fromEntries(looks.periods.map(period => [period.id, arrived.filter(item => item.ms > nowMs - period.hours * HOUR).length]));
    // A run still "working" long after it started is stuck, not going: it counts as a failure (invariant 7).
    const stuckAfter = looks.stuck_after_hours;
    const allRuns = (source.runs ?? []).map(run => ({ ...run, ms: time(run.at), result: resultOf(run.state) })).filter(run => known(run.ms)).sort((a, b) => b.ms - a.ms)
      .map(run => run.result === looks.in_progress_result && typeof stuckAfter === 'number' && nowMs - run.ms > stuckAfter * HOUR
        ? { ...run, result: looks.failure_result, error: run.error ?? looks.stuck_words } : run);
    const runs = allRuns.filter(run => run.ms > nowMs - runsPeriod.hours * HOUR);
    const results = {};
    for (const run of runs) results[run.result] = (results[run.result] ?? 0) + 1;
    const lastWorked = runs.find(run => looks.worked_results.includes(run.result));
    const failures = runs.filter(run => run.result === looks.failure_result);
    const lastFailure = failures[0] ?? null;
    const readers = (source.readers ?? []).map(reader => {
      const computer = reader.computer ?? 'This computer';
      const reported = time(reader.reported_at);
      const latest = time(reader.latest_item_at);
      const delivered = time(reader.last_sent_at);
      const readAt = time(reader.last_read_at);
      const stale = !known(reported) || nowMs - reported > looks.reader_stale_after_hours * HOUR;
      const behind = !stale && known(latest) && latest > (known(delivered) ? delivered : last?.ms ?? -Infinity)
        && nowMs - latest > looks.reader_item_grace_minutes * 60000;
      const failed = reader.failed?.error
        ? fill(looks.reader_words.failed, { computer, error: plainError(reader.failed.error, looks) }) : null;
      const problem = stale ? fill(looks.reader_words.stale, { computer })
        : failed ?? (reader.status !== 'working' && reader.status !== 'starting'
          ? fill(looks.reader_words.status, { computer, status: plainError(reader.status, looks) })
          : behind ? fill(looks.reader_words.behind, { computer }) : null);
      return { computer, status: reader.status, last_read_at: known(readAt) ? new Date(readAt).toISOString() : null,
        last_sent_at: known(delivered) ? new Date(delivered).toISOString() : null,
        latest_item_at: known(latest) ? new Date(latest).toISOString() : null, problem };
    });
    const poll = source.poll;
    const pollDue = time(poll?.next_at);
    const pollGrace = Math.max(looks.poll_grace_minutes ?? 1, poll?.every_minutes ?? 1) * 60000;
    const pollProblem = source.connected !== false && poll
      ? poll.gap ? fill(looks.poll_words.gap, { label })
        : poll.problem ? plainError(poll.problem, looks)
        : !known(pollDue) ? fill(looks.poll_words.missing, { label })
        : nowMs - pollDue > pollGrace ? fill(looks.poll_words.overdue, { label }) : null
      : null;
    const pendingProblem = source.connected !== false && source.pending_admissions > 0
      ? fill(looks.poll_words.pending, { label, count: source.pending_admissions }) : null;
    const connectionAttempts = source.connection_attempts ?? [];
    const setupProblem = connectionAttempts.find(attempt => attempt.problem)?.problem;
    const readerProblem = readers.find(reader => reader.problem)?.problem
      ?? (setupProblem ? plainError(setupProblem, looks) : null) ?? pollProblem ?? pendingProblem;
    const within = kind.expect_within_hours;
    const silence = within === null || within === undefined ? looks.silence_words.not_expected
      : last !== null && last.ms > nowMs - within * HOUR ? looks.silence_words.within : looks.silence_words.longer;
    const connected = source.connected !== false;
    // "Working" is earned: a real arrival, or a run that really finished, inside the kind's working window.
    const windowMs = kind.working_within_hours == null ? Infinity : kind.working_within_hours * HOUR;
    const recent = (last !== null && nowMs - last.ms <= windowMs)
      || allRuns.some(run => run.result === looks.finished_result && nowMs - run.ms <= windowMs);
    const noReader = kind.needs_reader === true && readers.length === 0;
    const sinceWords = last ? new Date(last.ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    const idleWords = recent ? null : fill(looks.idle_words[noReader ? (last ? 'no_reader' : 'no_reader_never') : (last ? 'since' : 'never')], { label, time: sinceWords });
    // What the last arrival started: each rule's run, how it ended, and why when it failed.
    const started = last ? allRuns.filter(run => run.arrival_id !== undefined && run.arrival_id === last.id).map(run => ({
      rule_id: run.rule_id ?? null, rule_label: ruleLabel(run.rule_id), state: run.state, result: run.result,
      ...(run.run_id ? { run_id: run.run_id } : {}), ...(run.task_id ? { task_id: run.task_id } : {}),
      ...(run.result === looks.failure_result ? { error_words: plainError(run.error ?? run.state, looks) } : {}),
    })) : [];
    return {
      shown: {
        source_id: source.source_id,
        kind: source.kind,
        kind_label: kind.label ?? source.kind,
        label,
        connected,
        last: last ? { at: new Date(last.ms).toISOString(), title: titleOf(last) } : null,
        nothing_yet: last ? null : fill(looks.nothing_yet, { label }),
        last_started: started,
        arrivals,
        ...(source.or_more ? { or_more: source.or_more } : {}),
        rules,
        fires: runs.length,
        results,
        last_error: lastFailure ? { words: plainError(lastFailure.error ?? lastFailure.state, looks), at: new Date(lastFailure.ms).toISOString(), ...(lastFailure.rule_id ? { rule_id: lastFailure.rule_id, rule_label: ruleLabel(lastFailure.rule_id) } : {}) } : null,
        readers,
        ...(source.connection_attempts ? { connection_attempts: connectionAttempts } : {}),
        ...(poll ? { poll } : {}),
        ...(source.pending_admissions !== undefined ? { pending_admissions: source.pending_admissions } : {}),
        reader_problem: readerProblem,
        silence,
        idle_words: idleWords,
      },
      row: { connected: connected ? 'yes' : 'no', silence, recent_activity: recent ? 'yes' : 'no', reader_present: noReader ? 'no' : 'yes', failures_since_it_worked: failures.filter(run => !lastWorked || run.ms > lastWorked.ms).length, reader_issue: readerProblem ? 'yes' : 'no', setup_issue: setupProblem ? 'yes' : 'no' },
    };
  }

  /** input: { now, sources: [{ source_id, kind, label, connected, arrived: [{ id, at, title?, subject?, text? }],
   *  rules: [{ rule_id, label, enabled }], runs: [{ at, state, error?, rule_id?, arrival_id?, run_id?, task_id? }] }] } */
  async function readSourceHealth(input) {
    const nowMs = known(time(input?.now)) ? time(input.now) : Date.now();
    const read = (Array.isArray(input?.sources) ? input.sources : []).map(source => facts(source, nowMs));
    const stateOf = new Array(read.length).fill(null);
    for (const state of looks.states) {
      const open = stateOf.map((value, index) => (value === null ? index : -1)).filter(index => index >= 0);
      if (!open.length) break;
      if (!state.rules) { for (const index of open) stateOf[index] = state; break; }
      const { matches } = await filterRows({ tree: state.rules, fields: looks.fields, rows: open.map(index => read[index].row) });
      for (const match of matches) stateOf[open[match]] = state;
    }
    return {
      sources: read.map(({ shown }, index) => {
        const state = stateOf[index];
        return { ...shown, state: state?.id ?? null, look: state ? { label: state.label_by_kind?.[shown.kind] ?? state.label, tone: state.tone } : null };
      }),
      periods: looks.periods.map(({ id, label }) => ({ id, label })),
      runs_counted_over: looks.runs_counted_over,
      states: Object.fromEntries(looks.states.map(state => [state.id, { label: state.label, tone: state.tone }])),
      results: looks.result_looks,
      words: { started_nothing: looks.started_nothing },
    };
  }
  return { readSourceHealth };
}

