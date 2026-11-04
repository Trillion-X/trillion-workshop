// src/keep-running.mjs
//
// Purpose
//   Anything this account started that should keep going keeps going by itself. Each sweep (the scheduler source
//   `keep-running`, every `every_minutes` of src/keep-running.json, and tool:keep-things-running when anyone asks) reads
//   what is meant to keep running and finds what stopped: timed work the scheduler held after its last automatic try,
//   schedules whose last run failed or never started, schedules whose time passed without a run, workflow runs that
//   stopped moving, capabilities whose check (src/capability-checks.mjs) failed again and again, decisions whose next action nobody said was done once the turn that decided them has had
//   `decision_owed_after_minutes`, and services the person's own AIs work through that refuse work (out of credit, a
//   refused key), which only the person can fix, and the person's own work (a recording, a press, a share from their
//   phone: priority at or above the line their own words carry) that no AI has taken `own_work_waiting_after_minutes`
//   after it was handed, and the person's own messages whose decision was opened by a road that handed them to no AI
//   (handed as that message's own job, once per message). Every input is kept and handed on an event; this reads the state those events should have
//   produced, so a link that broke anywhere (no taker, a refused service, a missing priority) is never silent: on
//   2026-10-04 eleven of one person's recordings sat untaken for up to nine hours and nothing said so. A decision owed goes to one AI as one job, never to every AI that starts work: told
//   to every take_work, it set every lane redoing what another was still doing or had already done. A stopped thing is started again; when starting it again did not keep it going, or it cannot start
//   by itself, one job is handed to whichever of the person's AIs takes it first and the person is told, once per stop.
//
// Non-negotiable invariants
//   1. One stop is acted on once: a restart is counted before it is tried, each hand-off has an idempotency key
//      (agents.handOff once_per), and every hand-off for the same stop uses one canonical, idempotent notice key.
//      A sweep cut off after notice delivery may replay the call, but the owner does not create a second notice.
//      A stop is named by the thing's own facts (`stop`: when a held entry first failed, the schedule run that failed,
//      the time a schedule was due, the time a workflow run last moved), never by when a sweep first saw it: a sweep
//      that missed it (a busy read) once lost its mark, minted a new first sight and handed the same stop again.
//      A repeated hand-off reconciles the notice through its canonical idempotency key.
//   2. A thing is known by what it is (a held entry's key, a schedule, a workflow step), never by one failure of it, so
//      a restart that stops again within `restarts_remembered_hours` goes to an AI instead of restarting forever.
//      Something moving again past that window, or after an AI was handed it, is let go, so its next stop starts over.
//   3. Nothing here names a source, tool, schedule or workflow: what counts as stopped comes from the readers, and
//      every word, wait and limit is DATA (src/keep-running.json).
//   4. A sweep hands off at most `most_handed_off_per_sweep` jobs, taking the kinds of stop in turn (inTurns) so one kind
//      with many stops never keeps another from being handed; stops already handed take no turn, and the rest are
//      handed off on the next sweep.
//   5. A sweep never throws for one thing: a restart or hand-off that fails is kept on that thing and tried again on
//      the next sweep.
//
// Key concepts
//   stopped thing  { key, kind, stop, title words, said, job, outcome, values, restart|null, left_to_its_job? },
//                  from stoppedThings(); left_to_its_job: a step whose own AI job is open is restarted (read) but never
//                  handed a second job
//   watched        this store's fact { watching, things: { key: { first_seen_at, stop, restarts, handed_off,
//                  last_problem } } }; watching is how many things the last sweep read. Written only when it changes.
//   clock          this store's small fact { idle_checked, idle_next_at, idle_code }: the cached idle answer. When the
//                  last sweep ran (swept_at) is kept with it while the store watches something, so a restart of the
//                  object does not sweep at once (an idle store keeps it in memory: it has no hourly wake). It changes on owner writes, so it is kept apart
//                  from `things`: each of those writes (and its record history) is a few dozen bytes, never the whole
//                  list of stopped things. An account that keeps nothing running asks for no periodic alarm;
//                  idleNext() names new work and pending deadlines, cached until an owner write or new Worker code
//                  invalidates it.
//
import settings from './keep-running.json' with { type: 'json' };

export const KEEP_RUNNING = settings;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined || values[name] === null ? whole : String(values[name])));
const MINUTE = 60000;

/** The label a held scheduler entry is shown with: its own label, else its source name and what it was for. */
const heldLabel = entry => entry.label ?? entry.title ?? String(entry.key).split('|').filter(Boolean).join(' ');

/**
 * Everything that stopped, from what the readers returned. Pure.
 *   held       scheduler.status().failed (entries with held true are stopped)
 *   schedules  automations.listSchedules().schedules, each with `ended` (the end state of the run its last_run started,
 *              { state, error } or null) added by the caller
 *   runs       raw workflow runs ({ run_id, recipe, state, started_at, done, waiting })
 *   owed       decisions decided long enough ago whose next action nobody said was done ({ case_id, goal, next_action,
 *              success_measure, decided_at }, DecisionEngine.notCarriedOut)
 *   refused    services the person's own AIs work through that refuse work now ({ provider, label, since, why },
 *              ownAisRouting refusals)
 *   waiting    the person's own work nobody took, open past `own_work_waiting_after_minutes` ({ handoff_id, said,
 *              handed_at }), oldest first
 *   checks     capabilities that stopped working (src/capability-checks.mjs stopped(): { check, label, owner,
 *              failing_since, failures, problem, probe, expect, read, last_worked })
 *   unowned    the person's own messages whose decision was opened and never handed to any AI ({ case_id,
 *              message_id, goal, created_at }, DecisionEngine.undecidedMessages with no job for the message)
 *   unclassified  the person's own words the classifier on their computer never answered about ({ message_id, at,
 *              facts }), past their wait: asked again (restart ask-again), and handed to an AI if asking again fails
 */
// When the run's card was last written (the reader's card_at), kept on its mark so a later sweep that finds the card
// unchanged and its job still open carries the mark without reading the run again.
const seen = run => (run.card_at ? { card_at: run.card_at } : {});

export function stoppedThings({ now, held = [], schedules = [], runs = [], owed = [], refused = [], waiting = [], checks = [], unowned = [], unclassified = [], rules = settings }) {
  const found = [];
  for (const entry of held) {
    if (!entry.held) continue;
    found.push({ key: `held:${entry.key}`, kind: 'held', stop: entry.first_failed_at ?? entry.last_failed_at ?? String(entry.failures ?? ''), values: { label: heldLabel(entry), failures: entry.failures, error: entry.error ?? '', key: entry.key }, restart: { kind: 'release', key: entry.key } });
  }
  for (const schedule of schedules) {
    if (schedule.enabled === false || schedule.enabled === 'off') continue;
    const label = schedule.label ?? schedule.schedule_id;
    const last = schedule.last_run;
    const problem = last?.problem ?? (schedule.ended?.state === 'failed' ? schedule.ended.error ?? 'its run failed' : null);
    if (last && problem) {
      found.push({ key: `schedule:${schedule.schedule_id}`, kind: 'schedule_failed', stop: last.at ?? last.task_id ?? last.run_id ?? '', values: { label, schedule_id: schedule.schedule_id, error: typeof problem === 'string' ? problem : JSON.stringify(problem) }, restart: { kind: 'run-now', schedule_id: schedule.schedule_id } });
      continue;
    }
    const due = Date.parse(schedule.next_run_at ?? '');
    if (Number.isFinite(due) && due < now - rules.late_schedule_grace_minutes * MINUTE) {
      found.push({ key: `schedule:${schedule.schedule_id}`, kind: 'schedule_late', stop: schedule.next_run_at, values: { label, schedule_id: schedule.schedule_id, due_at: schedule.next_run_at }, restart: { kind: 'run-now', schedule_id: schedule.schedule_id } });
    }
  }
  // Every working and stuck run is read however long ago it last moved: a run is started work, and work left past a
  // looked-back window was let go with nobody told (2026-10-13: the person's X-mode run waited a day at its second step).
  for (const run of runs) {
    // A terminal engine failure still owes the requested outcome. Explicit withdrawal is the separate durable
    // stop contract; it never becomes recovery work, even if a stale card reaches this full-state read.
    if (run.withdrawal) continue;
    if (run.state === 'failed') {
      found.push({ key: `workflow-failed:${run.run_id}`, kind: 'workflow_failed', ...seen(run),
        stop: run.card_at ?? run.finished_at ?? run.error ?? run.started_at ?? '',
        values: { run_id: run.run_id, workflow: run.recipe?.label ?? run.recipe?.id ?? run.run_id, error: run.error ?? 'The workflow could not go on.' },
        restart: { kind: 'resume', run_id: run.run_id } });
      continue;
    }
    if (!['working', 'stuck'].includes(run.state) || !run.waiting?.length) continue;
    const moved = Math.max(Date.parse(run.started_at ?? '') || 0, ...Object.values(run.done ?? {}).map(step => Date.parse(step?.admitted_at ?? '') || 0));
    // A stuck run (Trillion could not reach a step again and again) is stopped already: it is resumed, then handed on.
    if (run.state === 'stuck') {
      const step = run.waiting[0];
      found.push({ key: `workflow:${run.run_id}:${step.step_id}`, kind: 'workflow_stuck', ...seen(run), stop: run.interrupted?.since ?? new Date(moved).toISOString(), values: { run_id: run.run_id, workflow: run.recipe?.label ?? run.recipe?.id ?? run.run_id, step: step.title ?? step.step_id, tries: run.interrupted?.tries ?? '', error: run.interrupted?.error ?? run.error ?? '' }, restart: { kind: 'resume', run_id: run.run_id } });
      continue;
    }
    // A step waiting for a time (a workflow wait, src/workflows.mjs answerWait) is not stopped before that time, and is
    // read again as soon as it has passed, which answers it.
    const until = Date.parse(run.waiting[0].waits_until ?? '');
    if (Number.isFinite(until) && until > now) continue;
    if (!Number.isFinite(until) && moved > now - rules.workflow_stalled_after_hours * 60 * MINUTE) continue;
    // A step a tool runs is the Workshop's to carry (its own retries); only a step waiting for an AI stops here.
    const step = run.waiting[0];
    if (step.tool_run && step.tool_run.state !== 'failed') continue;
    const since = new Date(Number.isFinite(until) ? until : moved).toISOString();
    // Reading the run first admits what its step's job or tool already handed back (a job finished where the run never
    // heard of it, as a sorter's close once did). A step that handed its own job to an AI is then left to that job: the
    // job system keeps offering it and finishing it carries the run on (person-store stepRunsOn). A second job beside it
    // was never taken either (2026-10-07: every stalled run's own job and its keep-running job sat open side by side),
    // since whatever kept the first job from being taken keeps a second one too.
    const own = step.agent?.handoff_id && step.agent.state !== 'finished' ? step.agent.handoff_id : null;
    found.push({ key: `workflow:${run.run_id}:${step.step_id}`, kind: 'workflow_stalled', ...seen(run), stop: since, values: { run_id: run.run_id, workflow: run.recipe?.label ?? run.recipe?.id ?? run.run_id, step: step.title ?? step.step_id, since, ...(own ? { its_own_job: own } : {}) }, restart: { kind: 'admit', run_id: run.run_id }, ...(own ? { left_to_its_job: true } : {}) });
  }
  // A service one of the person's own AIs works through that refuses work (out of credit, a refused key) needs the person: it is
  // told once per refusal, named by when the refusal began.
  for (const item of refused) {
    found.push({ key: `refused:${item.provider}`, kind: 'service_refused', stop: item.since, values: { label: item.label, provider: item.provider, since: item.since, why: item.why ?? '' }, restart: null });
  }
  // The person's own work that no AI took is told to the person, never handed to another AI: whatever kept the first
  // job from being taken would keep a second one too. Named by the job and when it was handed, so it is told once.
  for (const item of waiting) {
    const minutes = Math.max(0, Math.floor((now - Date.parse(item.handed_at)) / MINUTE));
    found.push({ key: `waiting:${item.handoff_id}`, kind: 'own_work_waiting', stop: item.handed_at, values: { said: item.said ?? item.handoff_id, handoff_id: item.handoff_id, minutes }, restart: null });
  }
  // A capability that stopped working (src/capability-checks.mjs) goes to an AI with what its check saw: the check is
  // tried again by its own runner before it counts, so there is nothing to restart here.
  for (const item of checks) {
    found.push({ key: `check:${item.check}`, kind: 'check_failed', stop: item.failing_since, values: { label: item.label, check: item.check, owner: item.owner || '', since: item.failing_since, failures: item.failures, problem: item.problem ?? '', last_worked: item.last_worked ?? 'never', probe: JSON.stringify(item.probe), expect: JSON.stringify(item.expect), read: JSON.stringify(item.read) }, restart: null });
  }
  for (const item of owed) {
    found.push({ key: `decision:${item.case_id}`, kind: 'decision_owed', stop: item.decided_at, values: { case_id: item.case_id, goal: item.goal, next_action: item.next_action, success_measure: item.success_measure, decided_at: item.decided_at }, restart: null });
  }
  // The person's own words with a decision and no job: handed as that message's own job (once per message, so the job
  // an arrival would have made and this one are the same job), at the priority the person's own words carry.
  for (const item of unowned) {
    found.push({ key: `words:${item.message_id}`, kind: 'words_unowned', stop: item.created_at, values: { case_id: item.case_id, message_id: item.message_id, goal: item.goal, opened_at: item.created_at }, restart: null,
      hand: { once_per: item.message_id, case_id: item.case_id, input: { arrived: { message_id: item.message_id, case_id: item.case_id, from_person: true } } } });
  }
  for (const item of unclassified) {
    const words = String(item.facts?.text ?? '').trim().replace(/\s+/g, ' ');
    found.push({ key: `unclassified:${item.message_id}`, kind: 'words_unclassified', stop: item.at, values: { message_id: item.message_id, words: words.slice(0, 200), route: item.facts?.route ?? '' }, restart: { kind: 'ask-again', message_id: item.message_id },
      hand: { once_per: item.message_id, input: { arrived: { message_id: item.message_id, from_person: true } } } });
  }
  return found.map(thing => ({ ...thing, words: rules.words[thing.kind] }));
}

// How each kind of restart a stopped thing names is carried out by this store's doers.
const RESTARTS = {
  release: (act, restart) => act.release(restart.key),
  'ask-again': (act, restart) => act.askAgain(restart.message_id),
  'run-now': (act, restart) => act.runNow(restart.schedule_id),
  admit: (act, restart) => act.admit(restart.run_id),
  resume: (act, restart) => act.resume(restart.run_id),
};

/**
 * The sweep, over this store's readers and doers.
 *   read     { held(), schedules(), runEnd(started), runs(), idleNext() }
 *   act      { release(key), runNow(schedule_id), admit(run_id), resume(run_id), askAgain(message_id), handOff(input), tell(input) }
 *   watched  { read(), write(value) } this store's fact of stopped things
 *   clock    { read(), write(value) } this store's small fact of sweep time and the cached idle answer
 */
// Stopped things taken one kind at a time, in turn (the first of each kind, then the second of each, and so on), each
// kind keeping its own order: a sweep's room to hand off (most_handed_off_per_sweep) is shared by every kind, so many
// stops of one kind never keep another kind from ever being handed (on 2026-10-07 twenty owed decisions and twenty
// untaken jobs took every sweep's room, and no unowned message of the person's was handed at all).
export function inTurns(things) {
  const kinds = new Map();
  for (const thing of things) kinds.set(thing.kind, [...(kinds.get(thing.kind) ?? []), thing]);
  const lines = [...kinds.values()];
  const longest = Math.max(0, ...lines.map(line => line.length));
  return Array.from({ length: longest }, (_, turn) => lines.map(line => line[turn]).filter(Boolean)).flat();
}

export function makeKeepRunning({ read, act, watched, clock, now = () => Date.now(), rules = settings, code = null }) {
  // This owner alone writes its two facts. Keep the values it read or wrote for this
  // store instance: nextAt() is called for every alarm source gather, and reading the
  // same record twice on each gather billed hundreds of rows on older stores.
  let current;
  let currentClock;
  let idleRead = false;
  let idleAt = null;
  let revision = 0;
  let sweepInFlight = null;
  let publishingClock = false;
  const kept = () => (current ??= watched.read() ?? {});
  const keptClock = () => (currentClock ??= clock.read() ?? {});
  // The clock is this owner's observation. Its synchronous write notification
  // cannot itself invalidate that observation. Keep the guard local to the
  // actual publication call; unrelated later customer changes still invalidate.
  const publishClock = value => {
    const previous = publishingClock; publishingClock = true;
    try { return clock.write(value); }
    finally { publishingClock = previous; }
  };
  const tick = async value => {
    if (JSON.stringify(value) === JSON.stringify(keptClock())) return;
    await publishClock(value);
    currentClock = structuredClone(value);
  };
  const invalidate = () => {
    if (publishingClock) return;
    revision += 1;
    idleRead = false;
    const time = keptClock();
    // With no saved idle answer, invalidation has nothing durable to clear.
    // Leave the full watched-work history lazy until a scheduling read needs it.
    if (!time.idle_checked || kept().watching) return;
    // The person store's fact write is synchronous: a relevant owner write marks the
    // cached empty answer stale before its scheduler arm, including across hibernation.
    const dirty = { ...time, idle_checked: false };
    publishClock(dirty);
    currentClock = dirty;
  };
  // The stopped things are written only when they changed. The sweep's time is kept in memory: a store that wakes
  // without it sweeps at once (nextAt), and a sweep that finds nothing new writes nothing. Writing it on every sweep
  // also dropped the cached idle answer, so an idle store wrote two records an hour, a quarter of what it wrote in a day.
  // A cached idle answer is the time an owner could next have stopped; once a sweep has run at or after it, that time is
  // spent, so it is dropped and read again (kept, it was due again a second later, forever: on 2026-10-06 woken stores
  // swept once a second until this was found).
  const keep = async (value, at) => {
    if (JSON.stringify(value) !== JSON.stringify(kept())) { await watched.write(value); current = structuredClone(value); }
    const time = keptClock();
    const spent = time.idle_checked && time.idle_next_at !== null && time.idle_next_at !== undefined && time.idle_next_at <= Date.parse(at);
    // A store that is watching something keeps its sweep time (nextWanted waits an hour from it): kept in memory only,
    // every restart of the object swept at once, and each sweep handed more of the old backlog (2026-10-08: a sweep every
    // 2.5 to 6 minutes). An idle store has no hourly wake, so its sweep time stays in memory.
    if (value.watching) await tick({ ...time, ...(spent ? { idle_checked: false } : {}), swept_at: at });
    else {
      if (spent) await tick({ ...time, idle_checked: false });
      currentClock = { ...keptClock(), swept_at: at };
    }
    idleRead = false;
  };

  // A hand-off is still being worked while its job is open (or taken, or blocked with its wall said). A job that ended while
  // the thing it was for is still stopped at the same stop ended without its outcome: the thing is handed again
  // (2026-10-13: a stop handed once was marked done for good, whatever became of its job). A notice alone (told) has no job.
  const stillOn = handed => Boolean(handed) && (handed.told || !handed.handoff_id || read.jobOpen?.(handed.handoff_id) !== false);
  // Whether a moving run's card shows it cannot need anything from this sweep: it waits for a time still to come, it moved
  // too lately to have stalled, its step's own job is open, or it was handed for this same unchanged card and that job is
  // still on. Such a run is not read; one handed is carried in `carried`. Every other run is read, oldest first.
  const runWatch = (at, before, carried) => ({
    at,
    skip: ({ at: written, card }) => {
      const step = card.waiting?.[0] ?? {};
      if (card.state === 'failed' && card.recoverable === false) return true;
      const key = card.state === 'failed' ? `workflow-failed:${card.run_id}` : `workflow:${card.run_id}:${step.step_id}`;
      if (before[key]?.notice_sent === false) return false;
      if (card.state === 'working') {
        const until = Date.parse(step.waits_until ?? '');
        if (Number.isFinite(until) ? until > at : Date.parse(written) > at - rules.workflow_stalled_after_hours * 60 * MINUTE) return true;
        if (step.handoff_id && read.jobOpen?.(step.handoff_id) === true) return true;
      }
      const mark = before[key];
      if (!mark?.handed_off || mark.card_at !== written || !stillOn(mark.handed_off)) return false;
      carried.add(key);
      return true;
    },
  });

  async function gather() {
    const at = now();
    const before = kept().things ?? {};
    const carried = new Set();
    const [held, schedules, runs, owed, refused, waiting, checks, unowned, unclassified] = await Promise.all([read.held(), read.schedules(), read.runs(runWatch(at, before, carried)), read.owed?.() ?? [], read.refused?.() ?? [], read.waiting?.(at - rules.own_work_waiting_after_minutes * MINUTE) ?? [], read.checks?.() ?? [], read.unowned?.() ?? [], read.unclassified?.() ?? []]);
    // A schedule is checked at its own times (read.idleNext), never by the hour: its alarm wakes for it anyway.
    // A run is the same: one moving normally is looked at when it could have stalled (read.idleNext), and one already
    // stalled is watched only until it is handed on or left to its own job. Counting every working run kept a store
    // whose run nobody took waking every hour for the whole looked-back week (2026-10-08: the daily briefing's run).
    const withEnds = await Promise.all(schedules.map(async schedule => {
      const started = schedule.last_run && (schedule.last_run.task_id || schedule.last_run.run_id) ? { task_id: schedule.last_run.task_id, run_id: schedule.last_run.run_id } : null;
      const ended = started ? await read.runEnd(started).catch(error => ({ state: 'failed', error: String(error?.message ?? error) })) : null;
      return { ...schedule, ended };
    }));
    const stopped = stoppedThings({ now: at, held, schedules: withEnds, runs, owed, refused, waiting, checks, unowned, unclassified, rules });
    const needsAnotherLook = (thing, marks) => marks[thing.key]?.notice_sent === false
      || (['workflow_stalled', 'workflow_stuck', 'workflow_failed'].includes(thing.kind) && !thing.left_to_its_job && !(marks[thing.key]?.handed_off && marks[thing.key].stop === thing.stop && stillOn(marks[thing.key].handed_off)));
    const watchingFor = marks => held.length + stopped.filter(thing => needsAnotherLook(thing, marks)).length + owed.length + refused.length + waiting.length + checks.length + unowned.length + unclassified.length;
    return { watching: watchingFor(before), watchingFor, stopped, carried };
  }

  async function performSweep() {
    const at = now();
    const { watchingFor, stopped, carried } = await gather();
    const before = kept().things ?? {};
    const next = {};
    // Runs handed for a card that has not changed since, whose job is still on, were not read again: their marks carry.
    for (const key of carried) if (before[key]) next[key] = before[key];
    // The saved watch count describes the state after each recovery action, including a delivered pending notice.
    const write = () => keep({ watching: watchingFor(next), things: next }, new Date(at).toISOString());
    const done = { restarted: [], handed_off: [], told: [], still_stopped: [], problems: [] };
    let handedThisSweep = 0;
    // Stops already handed for this same stop take no turn: they are only carried forward, so the kinds' turns are
    // shared among the stops still waiting (a kind's new stop sitting behind its handed ones was reached only after
    // every other kind's waiting stops were gone: on 2026-10-07 the person's untaken work waited behind owed decisions).
    const settled = thing => Boolean(before[thing.key]?.handed_off) && before[thing.key].stop === thing.stop
      && stillOn(before[thing.key].handed_off) && before[thing.key].notice_sent !== false;
    const tellHandoff = async (thing, values, once, handoffId) => {
      try {
        await act.tell({
          key: once, kind: rules.notice_kind, title: fill(thing.words.title, values),
          ...(handoffId ? { about: { kind: 'handoff', id: handoffId } } : {}),
          body: fill(thing.words.notice_body ?? (thing.restart ? rules.words.notice_body : rules.words.notice_body_handed_at_once), values),
        });
        return true;
      } catch (error) {
        done.problems.push({ key: thing.key, problem: `notice: ${String(error?.message ?? error).slice(0, 200)}` });
        return false;
      }
    };
    for (const thing of [...stopped.filter(settled), ...inTurns(stopped.filter(thing => !settled(thing)))]) {
      const mark = { first_seen_at: new Date(at).toISOString(), restarts: 0, handed_off: null, ...(before[thing.key] ?? {}) };
      // A hand-off belongs to the stop it was for; the same thing stopped anew (it moved in between) is handed again.
      // Restarts stay counted on the thing, so one that keeps stopping goes to an AI instead of restarting forever.
      if (mark.handed_off && mark.stop !== thing.stop) { mark.handed_off = null; mark.handed_again = 0; mark.notice_sent = undefined; }
      // The same stop whose job ended without its outcome is handed again, as a new job: a job's end is no proof its
      // thing moved, and only the thing moving (or its stop changing) lets it go.
      else if (mark.handed_off && !stillOn(mark.handed_off)) { mark.ended_job = mark.handed_off.handoff_id; mark.handed_off = null; mark.handed_again = (mark.handed_again ?? 0) + 1; }
      mark.stop = thing.stop;
      if (thing.card_at) mark.card_at = thing.card_at;
      next[thing.key] = mark;
      // Handoff and notice are separate outcomes. Persist the handoff before notifying so a crash or delivery error
      // cannot make the job look completed; retry the same notice key while the job remains open, without another job.
      if (mark.handed_off && stillOn(mark.handed_off)) {
        if (mark.notice_sent === false) {
          if (thing.words.tell_the_person === false) {
            mark.notice_sent = true;
            await write();
          } else {
            const noticeSent = await tellHandoff(thing, { ...thing.values, restarts: mark.restarts, ...(mark.handed_again ? { ended_job: mark.ended_job ?? '' } : {}) },
              `keep-running:${thing.key}:${thing.stop}`, mark.handed_off.handoff_id);
            if (noticeSent) { mark.notice_sent = true; await write(); }
          }
        }
        done.still_stopped.push(thing.key);
        continue;
      }
      if (mark.handed_off) { done.still_stopped.push(thing.key); continue; }
      const values = { ...thing.values, restarts: mark.restarts, ...(mark.handed_again ? { ended_job: mark.ended_job ?? '' } : {}) };
      if (thing.restart && mark.restarts < rules.restarts_before_handing_off) {
        // Counted before it is tried, so a sweep cut off mid-restart never restarts it twice.
        mark.restarts += 1;
        await write();
        try {
          mark.restarted_at = new Date(at).toISOString();
          await RESTARTS[thing.restart.kind](act, thing.restart);
          done.restarted.push(thing.key);
        } catch (error) {
          mark.last_problem = String(error?.message ?? error).slice(0, 300);
          done.problems.push({ key: thing.key, problem: mark.last_problem });
        }
        continue;
      }
      // A stop that already has its own open job is that job's: no second job, no notice.
      if (thing.left_to_its_job) { done.still_stopped.push(thing.key); continue; }
      if (handedThisSweep >= rules.most_handed_off_per_sweep) { done.still_stopped.push(thing.key); continue; }
      // A stop that is the person's to know, and no AI's to take (words.hand_off false), is told once and handed nowhere.
      if (thing.words.hand_off === false) {
        const once = `keep-running:${thing.key}:${thing.stop}`;
        try {
          await act.tell({ key: once, kind: thing.words.notice_kind ?? rules.notice_kind, title: fill(thing.words.title, values), body: fill(thing.words.body, values), refs: thing.values });
          mark.handed_off = { at: new Date(at).toISOString(), told: true };
          mark.notice_sent = true;
          handedThisSweep += 1;
          done.told.push(thing.key);
        } catch (error) {
          mark.last_problem = String(error?.message ?? error).slice(0, 300);
          done.problems.push({ key: thing.key, problem: mark.last_problem });
        }
        continue;
      }
      try {
        const again = mark.handed_again ? `:again:${mark.handed_again}` : '';
        const once = `keep-running:${thing.key}:${thing.stop}${again}`;
        // A stop that is some item's own missing work (thing.hand) is handed as that item's job: its once_per, decision
        // and arrival, so it can never be a second job beside the one the item should have had.
        const handed = await act.handOff({
          job: [fill(thing.words.job, values), ...(again ? [fill(rules.words.handed_again, values)] : [])].join(' '),
          said: fill(thing.words.said, values), outcome: fill(thing.words.outcome, values),
          success_condition: fill(thing.words.outcome, values), once_per: thing.hand?.once_per ? `${thing.hand.once_per}${again}` : once,
          priority: thing.words.priority ?? rules.hand_off_priority,
          ...(thing.hand?.case_id ? { case_id: thing.hand.case_id } : {}),
          input: { ...(thing.hand?.input ?? {}), keep_running: { key: thing.key, kind: thing.kind, ...thing.values } },
        });
        mark.handed_off = { at: new Date(at).toISOString(), handoff_id: handed?.handoff?.handoff_id ?? null };
        if (thing.words.tell_the_person === false) mark.notice_sent = true;
        else if (mark.notice_sent !== false && mark.notice_sent !== true) mark.notice_sent = Boolean(again);
        await write();
        // If hand-off reports a job already present after its mark was lost, use the same canonical notice key below:
        // the owner's idempotency makes recovery safe even when delivery committed before its result was lost.
        if (handed?.repeated) { done.still_stopped.push(thing.key); }
        else {
          handedThisSweep += 1;
          done.handed_off.push({ key: thing.key, handoff_id: mark.handed_off.handoff_id });
        }
        // Some stops are the AIs' own work (a decision they made and did not finish): the person is not told. A stop is
        // told once: handing it again after a job ended without its outcome shows on their AI work, not as a new notice.
        if (thing.words.tell_the_person === false || mark.notice_sent) continue;
        const noticeSent = await tellHandoff(thing, values, `keep-running:${thing.key}:${thing.stop}`, mark.handed_off.handoff_id);
        if (noticeSent) { mark.notice_sent = true; await write(); }
      } catch (error) {
        mark.last_problem = String(error?.message ?? error).slice(0, 300);
        done.problems.push({ key: thing.key, problem: mark.last_problem });
      }
    }
    // Not stopped now: a recent restart is remembered so a stop right after it goes to an AI; anything else is let go.
    const remembered = at - rules.restarts_remembered_hours * 60 * MINUTE;
    const moving_again = [];
    for (const [key, mark] of Object.entries(before)) {
      if (next[key]) continue;
      if (!mark.handed_off && Date.parse(mark.restarted_at ?? '') > remembered) next[key] = mark;
      else moving_again.push(key);
    }
    await write();
    return { swept_at: new Date(at).toISOString(), stopped: stopped.length, moving_again, ...done };
  }

  // A store can be entered by overlapping scheduler wakes. Share one complete read/act/write
  // cycle so a second sweep cannot observe the pre-restart mark and launch the same recovery.
  function sweep() {
    if (sweepInFlight) return sweepInFlight;
    const running = performSweep();
    sweepInFlight = running;
    running.finally(() => { if (sweepInFlight === running) sweepInFlight = null; }).catch(() => {});
    return running;
  }

  /** What would be acted on now, without acting. */
  async function status() {
    const { watching, stopped } = await gather();
    const things = kept().things ?? {};
    return { watching, last_swept_at: keptClock().swept_at ?? null, stopped: stopped.map(thing => ({ key: thing.key, kind: thing.kind, title: fill(thing.words.title, { ...thing.values, restarts: things[thing.key]?.restarts ?? 0 }), ...(things[thing.key] ?? { restarts: 0, handed_off: null }) })), every_minutes: rules.every_minutes };
  }

  /** Watch active work each hour. An empty account has no alarm; newly written work supplies its own first deadline.
   *  An owner time from before the last sweep, which that sweep already saw, waits `every_minutes` from it, never sooner. */
  const nextAt = async () => {
    const next = await nextWanted();
    const last = Date.parse(keptClock().swept_at ?? '');
    return next !== null && Number.isFinite(last) && next < last ? last + rules.every_minutes * MINUTE : next;
  };
  const nextWanted = async () => {
    const time = keptClock();
    const last = Date.parse(time.swept_at ?? '');
    if (kept().watching) return Number.isFinite(last) ? last + rules.every_minutes * MINUTE : now();
    if (!idleRead && time.idle_checked && time.idle_code === code) { idleAt = time.idle_next_at ?? null; idleRead = true; }
    if (!idleRead) {
      const before = revision;
      // A handed job that ended while its thing was still stopped is due now: the sweep hands it again. Every write of a
      // job marks this answer stale (person-store putHandoff), so its end is seen without an hourly wake.
      const ended = Object.values(kept().things ?? {}).some(mark => mark.handed_off?.handoff_id && !stillOn(mark.handed_off));
      const failed = !ended && await read.failedRunPending?.(runWatch(now(), kept().things ?? {}, new Set()));
      const next = ended || failed ? now() : ((await read.idleNext?.()) ?? null);
      if (before !== revision) return nextWanted();
      await tick({ ...keptClock(), idle_checked: true, idle_next_at: next, idle_code: code });
      idleAt = next;
      idleRead = true;
    }
    return idleAt;
  };

  return { sweep, status, nextAt, invalidate };
}
