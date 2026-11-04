// src/scheduler.mjs
//
// Purpose: the one owner of a Durable Object's alarm. Everything a Durable Object does at a time (a person's
// recurring schedules and one-off timed runs, a Workshop task scheduled for later, a booking reminder, a community
// digest, a hosted site going to sleep) is DATA handed to the Workshop tool tool:when-to-run-next (timed-action's
// whenToWake, run in process by src/built-in-tools.mjs); the alarm runs what it says is due and sets itself for the
// next time it names. No other code in a Durable Object calls setAlarm.
//
// Non-Negotiable Invariants:
//   1. A source contributes timed-action DATA (`schedules` with their `occurrence_states`, and one-off `time_windows`,
//      `actions` and `receipts`) and runs its own due work; the scheduler names no source, schedule or action.
//   2. Each wake records a recurring occurrence's materialization before running it (the source's compare-and-exchange
//      on its key), and records the owner's proof only after the run returned; a run that throws leaves its occurrence
//      or action due, so a later wake tries it again. Each run is charged as one failure, flushed to disk, before it
//      starts, and the charge is cleared when it returns: a run the platform ends (out of memory, a reset) throws
//      nothing and loses every unflushed write, so only this charge makes it wait out its backoff (invariant 4)
//      instead of being due again a second later. A charge stamped with older code (`code`) was left by a deploy
//      that reset the store mid-run, not by the run: the next wake gives it back uncounted and runs it again at once.
//      A charge whose run is still going in this instance is not a failure: status() lists it under `running`.
//   3. One source never stops another. A source whose `data()` throws, or that claims a schedule or action another
//      source already owns, is set aside for this wake and every other source is read, run and armed as usual; a run
//      that throws sets aside only that one schedule or action. What was set aside is kept in the failure record
//      (`kept`, the Durable Object's own storage when it has one) with the error said without secrets.
//   4. Retries are finite. A set-aside source or item is tried again after first_after_seconds, then factor times
//      longer each time up to longest_after_seconds (src/scheduler.json `retry`); after attempts_before_held failures
//      in a row it is held: it takes no automatic retry and asks for no alarm. A held entry comes back when the running
//      code changes (`code`, the Worker version) or through retry(), and status() lists every entry. A success clears
//      its entry; an entry whose source or item no longer exists is dropped.
//      An error that names when the work may run again (`retry_at`, epoch ms: a use budget reached, src/metered-use.mjs)
//      waits until exactly then and is not counted as a failure, so it is never held. A source may take
//      `failed(fire, action, problem)` to move the failed item's own due time to the problem's retry time.
//   5. A wake runs at most wake.most_runs due items, highest source `priority` first, and stops starting another item
//      after wake.max_wall_ms has elapsed. Anything waiting longer than wake.aging_seconds climbs one priority step
//      per such wait, so nothing starves; the rest stays due and the alarm comes back a second later. A wait starts
//      at the first wake that found the item due (or at its last run), not at the due time its source re-reads, and
//      ends at a wake where the item is not due. A source due on every wake therefore climbs like any other waiting
//      work and cannot hold the others out. One already
//      running item is allowed to finish so its owner proof and failure charge remain correct. last_wake says how many
//      were due, ran, failed and were left, and how long the oldest due item had been waiting.
//      Each run is also handed its stage budget, `{ budget_ms, left() }` (wake.stage_budget_ms): work that comes in
//      pages stops starting pages when `left()` is spent and leaves its cursor where it stopped, so no stage holds the
//      store for seconds. A store's first wake after it was built starts at most wake.cold_heavy_runs sources that
//      say they are `heavy` (the recurring catch-up stages); the rest wait for the next alarm, so a restart is never a
//      burst of everything owed. One-time builds and light sources are not held back.
//   6. After every wake and every change (arm), the alarm is set for the earliest of: a second from now when
//      something eligible is due, the next time the tool names, and the next retry of anything set aside. With none of
//      these the alarm is removed. The alarm is only ever set from the whole picture, so no source's time is dropped.
//      Only a wake moves the alarm later or removes it; any other arm only brings it earlier, and one that finds it past
//      its time sets it again for the next moment, so a store armed on every request is still woken (2026-10-05: one busy store was armed several times a second with something always due,
//      each arm moved its alarm a second ahead, and it was not woken for over an hour).
//   7. `now` is injected; the tool itself reads no clock.
//   8. Work running inside one wake may ask to arm after every write. Those requests keep one durable recovery
//      alarm without reading all the sources again; the wake's final fresh read includes every change. Deferral
//      ends before that read begins, so a concurrent request arriving during final planning still plans normally.
//      Overlapping ordinary foreground planners keep an immediate durable wake rather than repeat every timing
//      read; that wake gathers fresh data. Explicit retries and traced reads still inspect sources immediately.
//   9. A source with a share in policy.cpu_share rests after every run for as long as its run was charged, scaled by its
//      share of the hour: a run charged D ms (what the clock showed, never less than the source's floor_ms) rests
//      D x (3600 / seconds_per_hour - 1) ms, kept in memory (a store that started again runs it once at once, then keeps the
//      pace). A resting source is neither read nor run, its alarm time is the end of the rest, and a failed run rests too.
//      So between them the sources with a share use at most their shares of an hour (policy.cpu_share.budget_seconds_per_hour
//      in all) however much is waiting behind them. A source without a share is never held back by this.
//  10. A cold host restores a missing alarm from a fixed-field wake summary without constructing or gathering sources.
//      A prior-code hold, admission wait or abandoned charge needs a wake now; a current-code retry retains its saved deadline, and a
//      current-code hold stays held. Failure writes and their wake summary are one atomic durable storage batch. A
//      legacy host with no summary asks for one migration wake; the large failure record is read only by its alarm.
//      Settlement still belongs to gather in the alarm, never foreground construction.
//      An explicit durable token covers the host prelude, source gathering and final alarm planning too: a reset
//      there may leave no source charge. Only its own successfully rearmed wake clears that token; an overlapping
//      request cannot clear it, nor can an older completed wake clear a newer alarm's entry.
//  11. On a store whose wakes are being cut off (an earlier wake never finished, or a run is charged with stopping before
//      it finished), a source that says `first` is read and run before any other source of the wake is read, and what
//      that pass ran is kept on disk before the rest are read. An ordinary wake reads every source first, while what was
//      just written is still in memory and costs nothing to read. A wake's CPU is mostly spent reading sources; on a store whose reads have
//      grown dear (2026-10-14: the operator's store read 800,000 rows a wake before running anything) the reads ended
//      the wake inside the first run after them, that run was charged with the cut-off, and the record store's merges,
//      which are what make reads cheap again, were held after six such wakes. Work that lowers what every read costs
//      therefore never waits behind the reads it would make cheaper.
//  12. A run that made no progress is not run again a second later. Only the source knows whether its run moved its
//      work (rows written are no measure: work run as its own command, or on another object, writes none here), so a
//      run that made none says so: its result has `progress: false`. Its action then waits
//      no_progress.first_after_seconds, then factor times longer each time it again makes none, up to
//      longest_after_seconds (src/scheduler.json `no_progress`).
//      The wait holds only while the action is still due now and no earlier than it was: one that falls due earlier
//      (a new event) or at a later time runs as usual. A run that made progress, or retry(), ends the streak; it is
//      kept in memory, so a store that started again runs the action once at once. Re-armed a
//      second later for ever, such runs woke a book about 10 times a minute and wrote nothing (2026-10-22, own-records
//      book of account 3e43065d: decision-rechecks, rows_written 0 every run).
//
// A source is { name, priority?, heavy?, first?, data(pass) → partial WakeInput, run(dispatch, due) → { proof_ref? },
// materialized?(materialization), proven?(occurrence, owner_outcome), fired?(fire, action, result) }. dueAt(name, at,
// run) makes the common source whose only schedule is its own earliest due time (the Workshop's next scheduled task,
// the next reminder): it keeps no receipts, since running it moves its time on. `pass` is one object for every source
// of one read of the sources, so a fact they all ask is read once for that read (oncePerPass).
//
// Security: errors go into the failure record and the Worker's logs through withoutSecrets(), which removes bearer
// tokens, service keys, signed URL parameters and long opaque strings.
//
import settings from './scheduler.json' with { type: 'json' };

const iso = ms => new Date(ms).toISOString();

// A source that already knows its due time can bring the one alarm forward without reading every source.
// A past alarm is rearmed for the next moment: leaving it past due can keep it undelivered on workerd.
// Independent constructor/recovery owners may arm concurrently. Serialize their read/compare/write per storage
// object so a later target cannot overwrite an earlier alarm after both observed the same old value.
const knownArms = new WeakMap();
const alarmReads = new WeakMap();
function beginAlarmRead(alarm) {
  const reads = alarmReads.get(alarm) ?? new Set();
  alarmReads.set(alarm, reads);
  const read = { dueAt: null };
  reads.add(read);
  return read;
}
function endAlarmRead(alarm, read) {
  const reads = alarmReads.get(alarm);
  reads?.delete(read);
  if (!reads?.size) alarmReads.delete(alarm);
}
async function alarmTurn(alarm, work) {
  // A view over a store's alarm (turnKey: the store's own storage) queues behind every other arm of that same alarm.
  const key = alarm.turnKey ?? alarm;
  const arming = (knownArms.get(key) ?? Promise.resolve()).then(work);
  const settled = arming.catch(() => {});
  knownArms.set(key, settled);
  try { return await arming; }
  finally {
    if (knownArms.get(key) === settled) knownArms.delete(key);
  }
}
// A due time already past runs at once, one time. Asked for again by a wake that reached it and did not move it (a
// grant that cannot close until a command no owner can decide is settled), it waits as a failure does: first_after_seconds,
// then factor times longer up to longest_after_seconds (src/scheduler.json `retry`). Re-armed 1 ms later every time, one
// such grant woke its book about 46 times a minute and settled nothing (2026-10-17, RecordBook 4a33e3b9).
const pastDues = new WeakMap();
function pastDueTarget(key, dueAt, at) {
  const held = pastDues.get(key);
  if (held?.due === dueAt && at < held.until) return held.until;
  const step = held?.due === dueAt ? held.step + 1 : 0;
  const { first_after_seconds: first, factor, longest_after_seconds: longest } = settings.retry;
  const until = step === 0 ? at + 1 : at + Math.min(first * factor ** (step - 1), longest) * 1000;
  pastDues.set(key, { due: dueAt, step, until });
  return until;
}
export async function armKnownDue(alarm, dueAt, now = () => Date.now()) {
  if (!Number.isFinite(dueAt)) return false;
  // An alarm view that keeps its own owner's next due time hears every time asked for, even one the alarm already beats.
  alarm.noteDue?.(dueAt);
  // A wake's final gather may have already read this source. Retain requests arriving during that read until the
  // final alarm write; an obsolete empty/future answer must not delete or postpone newly persisted work.
  for (const read of alarmReads.get(alarm) ?? []) read.dueAt = read.dueAt === null ? dueAt : Math.min(read.dueAt, dueAt);
  return alarmTurn(alarm, async () => {
    const at = now();
    const set = (await alarm.getAlarm?.()) ?? null;
    const target = set !== null && set <= at ? at + 1 : dueAt <= at ? pastDueTarget(alarm.turnKey ?? alarm, dueAt, at) : dueAt;
    if (set === null || target < set || set <= at) {
      await alarm.setAlarm(target);
      return true;
    }
    return false;
  });
}
export const SCHEDULER_WAKE_KEY = `${settings.kept_under}:wake`;
const WAKE_SUMMARY = 'scheduler-wake-summary';
// Derived from the final merged failure state, inside the existing write owner. The size is independent of how many
// actions/schedules failed; individual charges and errors remain exclusively in the full failure record.
const admissionWait = (entry, at) => !entry.held && !entry.charge && entry.failures === 0
  && Number.isFinite(entry.retry_at) && entry.retry_at > at;
function wakeSummary(record, code, at) {
  let retryAt = null, held = false, charged = false, admission = false;
  for (const entry of Object.values(record?.entries ?? {})) {
    held ||= Boolean(entry.held);
    charged ||= Boolean(entry.charge);
    admission ||= admissionWait(entry, at);
    const due = code && entry.code !== code && (entry.held || entry.charge || admissionWait(entry, at)) ? at
      : !entry.held && Number.isFinite(entry.retry_at) ? entry.retry_at : null;
    if (due !== null && (retryAt === null || due < retryAt)) retryAt = due;
  }
  return { schema: WAKE_SUMMARY, code, retry_at: retryAt, held, charged, admission_wait: admission, unfinished: Boolean(record?.unfinished_wake) };
}
// Construction reads only the compact summary. Missing legacy metadata asks the existing alarm to establish it,
// never deserializes the full failure record or instantiates unrelated owners in the foreground.
export async function restoreSchedulerWake(alarm, code = null, now = () => Date.now()) {
  if (typeof alarm?.get !== 'function') return false;
  const summary = await alarm.get(SCHEDULER_WAKE_KEY);
  const at = now();
  const next = summary?.schema !== WAKE_SUMMARY || typeof summary.unfinished !== 'boolean' ? at
    : summary.unfinished ? at
    : code && summary.code !== code && (summary.held || summary.charged || (summary.admission_wait !== false && Number.isFinite(summary.retry_at))) ? at
    : Number.isFinite(summary.retry_at) ? summary.retry_at : null;
  return next === null ? false : armKnownDue(alarm, next, now);
}
// What a run's own charge says until the run returns or throws (wake): kept when the platform ends the run.
const CUT_OFF = 'It stopped before finishing. This record does not show why it stopped.';
const WAKE_FIELDS = ['schedules', 'occurrence_states', 'time_windows', 'actions', 'receipts'];
const SECRET_SHAPES = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]'],
  [/\b(authorization|x-api-key|api[-_]?key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[hidden]'],
  [/([?&](?:access_token|refresh_token|token|key|secret|signature|sig|password|code|client_secret|x-amz-signature)=)[^&\s"']+/gi, '$1[hidden]'],
  [/\b(?:sk|rk|pk|whsec|xox[abprs]|ghp|gho|ghs|github_pat|AKIA)[-_][A-Za-z0-9_-]{8,}/g, '[hidden]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[hidden]'],
  [/[A-Za-z0-9_+/=-]{40,}/g, '[hidden]'],
];

/** Error text with every credential-shaped part removed, at most 300 characters: what logs and records may keep. */
export function withoutSecrets(error) {
  let said = String(error?.message ?? error ?? '');
  for (const [shape, replacement] of SECRET_SHAPES) said = said.replace(shape, replacement);
  return said.slice(0, 300);
}

/** `read()` answered once for each pass of a scheduler read (data(pass)); with no pass (a source's run) it is read afresh. */
export function oncePerPass(read) {
  const answered = new WeakMap();
  return pass => {
    if (pass === undefined) return read();
    if (!answered.has(pass)) answered.set(pass, read());
    return answered.get(pass);
  };
}

/** A source whose one schedule is its earliest due time: `at()` → epoch ms or null, `run()` does what is due. */
export function dueAt(name, at, run) {
  return {
    name,
    // The time this source is next due, read without running it (null when it has nothing).
    nextAt: at,
    async data() {
      const ms = await at();
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return {};
      return { time_windows: [{ record_id: name, time_window_id: name, start: iso(ms) }], actions: [{ record_id: name, action_id: 'due', dispatch: { name } }] };
    },
    // A run that says whether it made progress (invariant 12) passes that on.
    run: async (_dispatch, _due, stage) => {
      const result = await run(stage);
      return { proof_ref: name, ...(typeof result?.progress === 'boolean' ? { progress: result.progress } : {}) };
    },
  };
}

// The failure record: the Durable Object's own storage when it has get/put (every Durable Object does), else memory.
// A write returns once the record is on disk (storage.sync): a Durable Object reset out of memory throws away every
// write it had not yet flushed, so an unflushed charge would vanish with the very run it was meant to hold back.
// Optional diagnostics expose only fixed stage names, durations and small counts; observer failures never affect scheduling.
function reportDiagnostic(observer, stage, startedAt, details = {}) {
  if (typeof observer !== 'function') return;
  try { observer({ stage, state: 'settled', duration_ms: Math.max(0, performance.now() - startedAt), ...details }); } catch { /* diagnostics cannot alter durable work */ }
}

function keptIn(alarm, code, now, diagnostic = null) {
  if (typeof alarm?.get === 'function' && typeof alarm?.put === 'function') {
    let summaryKept = false;
    const write = async (value, label = null) => {
      // Durable Object multi-key put is atomic: a reset cannot keep a charge but lose its recovery metadata (or the
      // reverse). Keep that entire batch durable before dispatch, without holding unrelated read output gates.
      const details = label ? { entry_count: Object.keys(value?.entries ?? {}).length } : {};
      let started = performance.now();
      if (label) reportDiagnostic(diagnostic, label + '_put', started, { ...details, state: 'entering' });
      await alarm.put({ [settings.kept_under]: value, [SCHEDULER_WAKE_KEY]: wakeSummary(value, code, now()) }, { allowUnconfirmed: true });
      if (label) reportDiagnostic(diagnostic, label + '_put', started, details);
      if (typeof alarm.sync === 'function') {
        started = performance.now();
        if (label) reportDiagnostic(diagnostic, label + '_sync', started, { ...details, state: 'entering' });
        await alarm.sync();
        if (label) reportDiagnostic(diagnostic, label + '_sync', started, details);
      }
      summaryKept = true;
    };
    return {
      read: async label => {
        const started = performance.now();
        if (label) reportDiagnostic(diagnostic, label + '_read', started, { state: 'entering' });
        const value = (await alarm.get(settings.kept_under)) ?? null;
        if (label) reportDiagnostic(diagnostic, label + '_read', started, { entry_count: Object.keys(value?.entries ?? {}).length });
        return value;
      },
      write,
      // Even an unchanged legacy snapshot must establish its summary. Subsequent unchanged arms still write nothing.
      ensureSummary: async value => {
        if (summaryKept) return;
        const summary = await alarm.get(SCHEDULER_WAKE_KEY);
        if (summary?.schema === WAKE_SUMMARY && typeof summary.unfinished === 'boolean') { summaryKept = true; return; }
        await write(value);
      },
    };
  }
  let value = null;
  return { read: async () => value, write: async next => { value = structuredClone(next); } };
}

// Planning and running await their sources, so their snapshots can overlap. Commit only each snapshot's changes,
// against the values it read: a late arm must not put back a charge a wake already cleared or erase a newer wake.
// Only the short read/merge/write is serialized; a source may itself await arm(). Unchanged arms still write nothing,
// and a changed charge is still on disk before its run starts.
function writtenWhenChanged(kept, diagnostic = null) {
  let committing = Promise.resolve();
  const bases = new WeakMap();
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const copy = value => ({ ...(value ?? {}), entries: { ...(value?.entries ?? {}) } });
  const commit = work => {
    const result = committing.then(work);
    committing = result.catch(() => {});
    return result;
  };
  return {
    // Entry tokens are allocated against the latest record inside this same
    // short commit queue. Two host preludes must never adopt the same token.
    update: (change, label = null) => {
      const queuedAt = performance.now();
      return commit(async () => {
        if (label) reportDiagnostic(diagnostic, label + '_queue', queuedAt);
        const value = copy(await kept.read(label));
        const started = performance.now();
        const before = structuredClone(value);
        change(value);
        const changed = !same(before, value);
        if (label) reportDiagnostic(diagnostic, label + '_clone_compare', started, { entry_count: Object.keys(value.entries ?? {}).length, changed });
        if (changed) await kept.write(value, label);
        else await kept.ensureSummary?.(value);
        bases.set(value, structuredClone(value));
        return value;
      });
    },
    read: () => commit(async () => {
      const value = copy(await kept.read());
      bases.set(value, structuredClone(value));
      return value;
    }),
    write: value => {
      const before = bases.get(value);
      const wanted = structuredClone(value);
      return commit(async () => {
        const current = copy(await kept.read());
        const merged = copy(current);
        const change = (base, next, latest, target) => {
          for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
            if (same(base[key], next[key]) || !same(base[key], latest[key])) continue;
            if (Object.hasOwn(next, key)) target[key] = next[key];
            else delete target[key];
          }
        };
        change(before.entries, wanted.entries, current.entries, merged.entries);
        const metadata = record => Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'entries'));
        change(metadata(before), metadata(wanted), metadata(current), merged);
        if (!same(current, merged)) await kept.write(merged);
        else await kept.ensureSummary?.(merged);
        // A wake writes more than once. Adopt concurrent changes too, so its next write does not delete them.
        for (const key of Object.keys(value)) delete value[key];
        Object.assign(value, structuredClone(merged));
        bases.set(value, structuredClone(merged));
      });
    },
  };
}

// Reject unsafe retry DATA before a scheduler can read sources or arm work. These bounds keep
// every retry delay positive, cap exponential growth, and ensure a broken item reaches held state.
const RETRY_RANGES = {
  first_after_seconds: { min: 1, max: 86400 },
  factor: { min: 1, max: 10 },
  longest_after_seconds: { min: 1, max: 604800 },
  attempts_before_held: { min: 1, max: 100, integer: true },
};

// The wait after a run that made no progress (invariant 12) has the same shape, without holding.
const { attempts_before_held: _held, ...NO_PROGRESS_RANGES } = RETRY_RANGES;

function validateBackoff(field, backoff, ranges) {
  if (!backoff || typeof backoff !== 'object' || Array.isArray(backoff)) {
    throw new TypeError(`scheduler ${field} policy must be an object`);
  }
  for (const [name, range] of Object.entries(ranges)) {
    const value = backoff[name];
    if (!Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) {
      throw new RangeError(`scheduler ${field}.${name} must be ${range.integer ? 'an integer ' : ''}from ${range.min} to ${range.max}`);
    }
  }
  if (backoff.longest_after_seconds < backoff.first_after_seconds) {
    throw new RangeError(`scheduler ${field}.longest_after_seconds must be at least ${field}.first_after_seconds`);
  }
}

// The shares must add up to the budget they are spent from, so the total is bounded by what the data says.
function validateCpuShare(cpuShare) {
  if (cpuShare === undefined) return;
  const budget = cpuShare.budget_seconds_per_hour;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 3600) throw new RangeError('scheduler cpu_share.budget_seconds_per_hour must be from 0 to 3600');
  let total = 0;
  for (const [name, share] of Object.entries(cpuShare.sources ?? {})) {
    if (!Number.isFinite(share?.seconds_per_hour) || share.seconds_per_hour <= 0 || share.seconds_per_hour >= 3600) throw new RangeError(`scheduler cpu_share.sources.${name}.seconds_per_hour must be above 0 and under 3600`);
    if (!Number.isFinite(share.floor_ms) || share.floor_ms < 0) throw new RangeError(`scheduler cpu_share.sources.${name}.floor_ms must be 0 or more`);
    total += share.seconds_per_hour;
  }
  if (total > budget) throw new RangeError(`scheduler cpu_share sources add up to ${total} seconds an hour, over the ${budget} budget`);
}

/**
 * alarm:   { setAlarm(ms), deleteAlarm(), get?, put? } (a Durable Object's ctx.storage)
 * sources: the sources above, or a function returning them (read at each wake)
 * builtIn: the Workshop tools this Worker runs in process (src/built-in-tools.mjs): { run(tool_id, input) }
 * code:    the running code's identity (the Worker version); a held entry is tried again once when it changes
 * kept:    { read() → record|null, write(record) } for the failure record
 * step:    (label, work) → work(): runs each source's `<name>:when` read and `<name>:run` run as one named step (the
 *          store's meter, src/metered-use.mjs, attributes what each uses to it)
 */
export function makeScheduler({ alarm, sources, builtIn, now = () => Date.now(), soonestMs = 1000, code = null, kept: keptGiven = null, policy = settings, step = (label, work) => work(), idle = () => false, headroom = () => null, onUnsettled = () => {}, trace = (message, details) => console.info(message, details), diagnostic = null }) {
  validateBackoff('retry', policy?.retry, RETRY_RANGES);
  const noProgress = policy.no_progress ?? settings.no_progress;
  validateBackoff('no_progress', noProgress, NO_PROGRESS_RANGES);
  validateCpuShare(policy.cpu_share);
  const shares = policy.cpu_share?.sources ?? {};
  // When each source with a share may be read and run again (invariant 9); in memory.
  const restUntil = new Map();
  const kept = writtenWhenChanged(keptGiven ?? keptIn(alarm, code, now, diagnostic), diagnostic);
  // An idle owner (its store erased or retired, src/person-store.mjs) lists no source at all: no wake reads or runs one of its work.
  const listed = () => (idle() ? [] : typeof sources === 'function' ? sources() : sources);
  const { retry, wake: limits } = policy;
  const waitAfter = failures => Math.min(retry.first_after_seconds * retry.factor ** (failures - 1), retry.longest_after_seconds) * 1000;
  // Actions whose last run made no progress (invariant 12): key -> { due, streak, until }; in memory.
  const stalled = new Map();
  const stallWait = streak => Math.min(noProgress.first_after_seconds * noProgress.factor ** (streak - 1), noProgress.longest_after_seconds) * 1000;
  const blocked = (entry, at) => Boolean(entry) && (entry.held || entry.retry_at > at);
  // A record-maintenance source a wake did not read, said at most once in five minutes: a source set aside, held or resting is never asked when it is
  // next due, so a book whose maintenance never ran (880c74dd, 2026-10-21) showed nothing of why its alarms did not run it.
  const skippedSaid = new Map();
  const saySkipped = (name, why, until, at) => {
    if (name !== 'record-maintenance' || at - (skippedSaid.get(name) ?? -Infinity) < 300000) return;
    skippedSaid.set(name, at);
    console.info('scheduler source not asked', { source: name, why, until: Number.isFinite(until) ? iso(until) : null });
  };
  // Whether a source has anything due, read without running it. A source that cannot answer counts as due, so its work
  // is never dropped for want of a wake.
  const hasDueWork = async source => {
    try { const data = (await step(`${source.name}:when`,()=>source.data({}))) ?? {}; return (data.schedules?.length ?? 0) + (data.actions?.length ?? 0) > 0; }
    catch { return true; }
  };
  // The answer of hasDueWork taken when a source's rest starts, after its run has taken what it ran. A resting source
  // is then not read again on every wake; a source with no answer yet still wakes for its rest end.
  const dueAtRestEnd = new Map();
  // A foreground arm can report new work after an empty rest snapshot. One
  // scalar generation invalidates those snapshots without rereading resting sources.
  let restInputGeneration = 0;
  // The charges whose runs this instance is running now; a reset starts a new instance with none.
  const running = new Set();
  // Source reads can await other owners before any run acquires a durable charge.
  // Keep one scalar interval per source, never its data or one entry per caller.
  // The interval starts with the first overlapping read and ends with the last.
  const reading = new Map();
  let deferArmRequests = false;
  let deferredArm = null;
  let ordinaryArmRunning = false;
  // This instance's first wake is its cold start: it starts only so many `heavy` sources.
  let cold = true;
  const stageMs = limits.stage_budget_ms ?? limits.max_wall_ms;

  async function readRecord() {
    return kept.read();
  }

  // One more failure of `key`: tried again after its backoff, or held after the last attempt. Returns the problem as
  // a wake reports it, and adds its retry time to `waiting`. `earlier` is the entry this failure follows when the
  // record already holds this run's own charge (wake), so one run is counted once.
  function setAside(record, waiting, key, fields, error, at, options = {}) {
    const earlier = 'earlier' in options ? options.earlier : record.entries[key];
    const quiet = options.quiet === true;
    // Work refused until a known time (a use budget reached, src/metered-use.mjs) waits until then and is no failure.
    // Work an unfenced attempt reached a rights change in runs again at once, under the entry's own policy change
    // (src/account-policy-integration.mjs runs_again): backing it off left a deleting store's alarm, run again fenced,
    // with its deletion not yet due, wake after wake (2026-10-17). One immediate rerun per entry: a rerun that marks
    // again is an ordinary failure, counted, logged and backed off, until a run settles the entry.
    const runsAgain = error?.runs_again === true && earlier?.ran_again !== true;
    const until = runsAgain ? at : Number.isFinite(error?.retry_at) ? error.retry_at : null;
    const failures = (earlier?.failures ?? 0) + (until === null ? 1 : 0);
    const held = until === null && failures >= retry.attempts_before_held;
    const said = withoutSecrets(error);
    const entry = {
      key, ...fields, failures, held, error: said, code,
      first_failed_at: earlier?.first_failed_at ?? iso(at), last_failed_at: iso(at),
      retry_at: held ? null : until ?? at + waitAfter(failures),
      ...(error?.runs_again === true || earlier?.ran_again === true ? { ran_again: true } : {}),
    };
    record.entries[key] = entry;
    if (!held) waiting.push(entry.retry_at);
    if (!quiet && !runsAgain) console.error('scheduler', key, held ? 'held' : `retry ${failures}`, said);
    return { ...fields, error: said, ...(held ? { held: true } : { retry_at: iso(entry.retry_at) }) };
  }

  // A charge no run here holds was left by a store that ended mid-run. Stamped with older code, the deploy ended it:
  // the entry goes back to what it was before the run, due now, so a deploy never counts against a run. Stamped with
  // this code, something else ended it (out of memory, a CPU reset) and it stays counted.
  function settleCharges(record, at) {
    for (const entry of Object.values(record.entries)) {
      if (!entry.charge || running.has(entry.key)) continue;
      const { charge, ...counted } = entry;
      if (!code || entry.code === code) record.entries[entry.key] = counted;
      else if (charge.before) record.entries[entry.key] = { ...charge.before, retry_at: at };
      else delete record.entries[entry.key];
    }
  }

  // New code gets one more round of attempts at what the old code could not do. A known-time admission refusal
  // has no failed attempt and may no longer cover this source under new policy. Recheck it once through its normal
  // gate; genuine failure backoff and same-code admission deadlines remain unchanged.
  function releaseForNewCode(record, at) {
    if (!code) return;
    for (const entry of Object.values(record.entries)) {
      if ((entry.held || admissionWait(entry, at)) && entry.code !== code) record.entries[entry.key] = { ...entry, held: false, failures: 0, retry_at: at, released_for_code: code };
    }
  }

  // `only` reads just those sources (a wake's first pass, invariant 11); what no longer exists is judged against every
  // listed source and, for a source's own schedules and actions, only by a pass that read that source.
  async function gather(at, record, traceSources = false, only = null) {
    settleCharges(record, at);
    releaseForNewCode(record, at);
    const input = Object.fromEntries(WAKE_FIELDS.map(field => [field, []]));
    const owner = new Map();
    const problems = [];
    const waiting = [];
    const read = new Set();
    const seen = new Set();
    // When each action read here falls due (its time window's start), by its key.
    const starts = new Map();
    let sourceOrdinal = 0;
    const pass = {};
    for (const source of only ?? listed()) {
      const source_ordinal = sourceOrdinal++;
      // A migration-triggered first arm can be cut off by one synchronous source
      // before its meter can flush. Name each entry without logging its data.
      if (traceSources) trace('scheduler source entering', { source: source.name });
      seen.add(source.name);
      const own = record.entries[source.name];
      if (blocked(own, at)) { if (!own.held) waiting.push(own.retry_at); saySkipped(source.name, own.held ? 'held' : 'set aside', own.held ? null : own.retry_at, at); continue; }
      // A resting source runs no sooner than its rest ends, but it is woken for that moment only when it has due work.
      // Waking it for every rest end (2026-10-12: a source that ran 100 ms rests 8.9 s, so an idle store woke every
      // 8.9 s with nothing to do) made each finished run re-arm the alarm with nothing behind it.
      if ((restUntil.get(source.name) ?? 0) > at) {
        saySkipped(source.name, 'resting', restUntil.get(source.name), at);
        const proof = dueAtRestEnd.get(source.name);
        if (proof?.due !== false || proof.generation !== restInputGeneration) waiting.push(restUntil.get(source.name));
        continue;
      }
      let data;
      const dataStarted = performance.now();
      reportDiagnostic(diagnostic, 'scheduler_source_data', dataStarted, { state: 'entering', source_ordinal });
      let completed = false;
      const pending = reading.get(source.name) ?? { source: source.name, started_at: iso(now()), count: 0 };
      pending.count += 1;
      reading.set(source.name, pending);
      try { data = (await step(`${source.name}:when`, () => source.data(pass))) ?? {}; completed = true; } catch (error) { problems.push(setAside(record, waiting, source.name, { source: source.name, stage: 'data' }, error, at)); continue; }
      finally {
        reportDiagnostic(diagnostic, 'scheduler_source_data', dataStarted, { source_ordinal, completed });
        pending.count -= 1;
        if (pending.count === 0) reading.delete(source.name);
        const duration = performance.now() - dataStarted;
        if (duration >= 1000) trace('scheduler slow source', { source: source.name, stage: 'data', duration_ms: Math.round(duration) });
      }
      const keys = [...(data.schedules ?? []).map(schedule => `schedule:${schedule.schedule_id}`), ...(data.actions ?? []).map(action => `action:${action.record_id}`)];
      const taken = keys.find(key => owner.has(key));
      if (taken) { problems.push(setAside(record, waiting, source.name, { source: source.name, stage: 'data' }, `${owner.get(taken).name} and ${source.name} both schedule ${taken}`, at)); continue; }
      delete record.entries[source.name];
      read.add(source.name);
      const item = key => `${source.name}|${key}`;
      for (const key of keys) seen.add(item(key));
      const open = key => {
        const entry = record.entries[item(key)];
        if (!blocked(entry, at)) return true;
        if (!entry.held) waiting.push(entry.retry_at);
        return false;
      };
      // Only what belongs to a set-aside schedule or action leaves the input; every other row goes as the source gave it.
      const heldSchedules = new Set((data.schedules ?? []).filter(schedule => !open(`schedule:${schedule.schedule_id}`)).map(schedule => schedule.schedule_id));
      // An action whose last run made no progress waits out its stall while it is still due now, no earlier than it
      // was (invariant 12); due earlier or at a later time, it runs as usual.
      for (const window of data.time_windows ?? []) starts.set(item(`action:${window.record_id}`), Date.parse(window.start));
      const resting = action => {
        const key = item(`action:${action.record_id}`), stall = stalled.get(key), start = starts.get(key);
        if (!stall) return false;
        if (!(start >= stall.due && start <= at)) { stalled.delete(key); return false; }
        if (stall.until <= at) return false;
        waiting.push(stall.until);
        return true;
      };
      const heldRecords = new Set((data.actions ?? []).filter(action => !open(`action:${action.record_id}`) || resting(action)).map(action => action.record_id));
      const eligible = {
        schedules: (data.schedules ?? []).filter(row => !heldSchedules.has(row.schedule_id)),
        occurrence_states: (data.occurrence_states ?? []).filter(row => !heldSchedules.has(row.schedule_id)),
        time_windows: (data.time_windows ?? []).filter(row => !heldRecords.has(row.record_id)),
        actions: (data.actions ?? []).filter(row => !heldRecords.has(row.record_id)),
        receipts: (data.receipts ?? []).filter(row => !heldRecords.has(row.record_id)),
      };
      for (const field of WAKE_FIELDS) input[field].push(...eligible[field]);
      for (const schedule of eligible.schedules) owner.set(`schedule:${schedule.schedule_id}`, source);
      for (const action of eligible.actions) owner.set(`action:${action.record_id}`, source);
    }
    if (traceSources) trace('scheduler sources read');
    // What no longer exists (a removed source, a finished or deleted schedule) needs no retry. A removed source is judged
    // against every listed source; a finished schedule or action only for a source this pass read, so a pass that reads
    // some sources (invariant 11) forgets neither what it did not read nor what is gone.
    const listedNames = only ? new Set(listed().map(source => source.name)) : seen;
    for (const key of Object.keys(record.entries)) {
      const [name] = key.split('|');
      if (!listedNames.has(name) || (read.has(name) && key !== name && !seen.has(key))) delete record.entries[key];
    }
    // What is due is judged as of after every source was read, never before: a source that is due now names the time
    // it read (its own clock, a moment after `at`), and judged at `at` it was always a moment in the future, so it was
    // never run and the alarm came back a second later, forever (2026-10-05: about 280 stores woke once a second, each
    // reading its sources and writing its failure record, once a wake awaited a write before reading them).
    const answer = await builtIn.run('tool:when-to-run-next', { now: Math.max(at, now()), ...input, spread: settings.spread.on ? settings.spread : null });
    return { answer, owner, problems, waiting, starts, actions: new Map(input.actions.map(action => [action.record_id, action])) };
  }

  async function setFor(at, answer, waiting, fromWake, alarmRead = null, owner = null) {
    const dueNow = answer.recurring_due.length + answer.scheduled_due.length > 0;
    const later = [answer.next_wake_at === null ? null : Date.parse(answer.next_wake_at), ...waiting].filter(Number.isFinite);
    let next = dueNow ? at + soonestMs : later.length ? Math.max(Math.min(...later), at + soonestMs) : null;
    // Only a wake (the alarm handler) moves the alarm later or removes it. Every other arm only brings it earlier: a
    // later time set while another request is in flight is parked by the platform and can be applied over an earlier
    // one, leaving the alarm undelivered (workerd #7330), and a store armed on every request moved its own alarm on
    // each time. An alarm found past its time is set again for the next moment, which makes the platform deliver it.
    if (fromWake) {
      await alarmTurn(alarm, async () => {
        const requested = alarmRead?.dueAt;
        // Stop observing before awaiting storage. Newer known arms share this queue and run after this setter.
        endAlarmRead(alarm, alarmRead);
        if (Number.isFinite(requested)) {
          const earlier = Math.max(requested, now() + 1);
          next = next === null ? earlier : Math.min(next, earlier);
        }
        if (next === null) await alarm.deleteAlarm();
        else await alarm.setAlarm(next);
        // A wake that plans another within seconds says what for, so a store waking over and over names its cause.
        if (next !== null && next - at < 5000) {
          const due = [...answer.recurring_due.map(item => `schedule:${item.schedule_id}`), ...answer.scheduled_due.map(item => `action:${item.record_id}`)];
          // A source that can say why it is due (its `because`) says it beside its name.
          const named = key => { const source = owner?.get(key), why = source?.because?.(); return source ? (why ? `${source.name}: ${why}` : source.name) : key; };
          trace('scheduler wakes again soon', { in_ms: next - at, due: [...new Set(due.map(named))].slice(0, 10),
            asked_ms: Number.isFinite(requested) ? requested - at : null, waiting: waiting.length,
            soonest_retry_ms: waiting.length ? Math.min(...waiting.filter(Number.isFinite)) - at : null });
        }
      });
    } else if (next !== null) await armKnownDue(alarm, next, now);
    return { next_wake_at: next === null ? null : iso(next), due_now: dueNow, waiting: waiting.length };
  }

  // Sets the alarm for what is due now or next.
  async function arm({ fromWake = false, traceSources = false, finishedWake = null, refresh = false } = {}) {
    if (!fromWake) restInputGeneration += 1;
    if (deferArmRequests && !fromWake && !traceSources) {
      // A source may await this arm, so it cannot await the wake that owns it. Keep a near durable alarm first:
      // an interrupted wake still has a recovery path, while a successful wake replaces it with the exact time.
      deferredArm ??= (async () => {
        const at = now();
        await armKnownDue(alarm, at, now);
        return { next_wake_at: iso(at + 1), deferred: true };
      })().catch(error => { deferredArm = null; throw error; });
      return deferredArm;
    }
    if (ordinaryArmRunning && !fromWake && !traceSources && !refresh) {
      // Another foreground planner already reads the sources. A new change may
      // precede or follow its read, so keep an immediate durable wake instead of
      // sharing a possibly stale answer or starting another whole source scan.
      // Each call enters the alarm queue: a final wake planning concurrently
      // must observe this new deadline even if an earlier call already armed it.
      const at = now();
      await armKnownDue(alarm, at, now);
      return { next_wake_at: iso(at + 1), deferred: true };
    }
    const ordinary = !fromWake && !traceSources && !refresh;
    if (ordinary) ordinaryArmRunning = true;
    try {
      const at = now();
      const record = await readRecord();
      if (Object.keys(record.entries).length) onUnsettled();
      const alarmRead = fromWake ? beginAlarmRead(alarm) : null;
      try {
        const { answer, waiting, owner } = await gather(at, record, traceSources);
        await kept.write(record);
        const armed = await setFor(at, answer, waiting, fromWake, alarmRead, owner);
        if (fromWake && finishedWake !== null) {
          // The final alarm must survive a reset before its recovery token goes.
          // Reuse this planning snapshot: the write owner's compare-and-exchange
          // preserves a newer alarm entry or foreground change during setFor.
          if (typeof alarm.sync === 'function') await alarm.sync();
          if (record.unfinished_wake === finishedWake) {
            delete record.unfinished_wake;
            await kept.write(record);
          }
        }
        return armed;
      } finally { if (alarmRead) endAlarmRead(alarm, alarmRead); }
    } finally { if (ordinary) ordinaryArmRunning = false; }
  }

  // Runs what is due (bounded, highest priority and longest waiting first), records each outcome with its source,
  // then sets the alarm again from a fresh read.
  async function wake({ entered: enteredToken = null } = {}) {
    deferArmRequests = true;
    deferredArm = null;
    try {
      return await runWake(enteredToken);
    } finally {
      deferArmRequests = false;
      deferredArm = null;
    }
  }

  async function runWake(enteredToken) {
    const at = now();
    // Kept before any work, so a wake the platform ends (out of memory) still shows it started: a wake_started later
    // than last_wake.at is a wake that never finished.
    // The receipt is not a source failure. A resumed wake still respects each
    // held entry and retry deadline when it gathers, even if recovery wakes now.
    const unfinished = enteredToken ?? crypto.randomUUID();
    // A store whose wakes are being cut off: an earlier wake that never finished, or a run that stopped before finishing.
    let strained = false;
    const record = await kept.update(value => {
      strained = Boolean(value.wake_started && (!value.last_wake || value.last_wake.at < value.wake_started))
        || Object.values(value.entries).some(entry => entry.charge || entry.error === CUT_OFF);
      if (Object.keys(value.entries).length) {
        const started = performance.now();
        reportDiagnostic(diagnostic, 'scheduler_wake_unsettled', started, { state: 'entering' });
        let completed = false;
        try { onUnsettled(); completed = true; }
        finally { reportDiagnostic(diagnostic, 'scheduler_wake_unsettled', started, { completed }); }
      }
      value.wake_started = iso(at);
      // A newer host prelude may have entered while this one's defaults were
      // awaited. Its durable token remains responsible for that later work.
      if (enteredToken === null) value.unfinished_wake = unfinished;
    }, 'scheduler_wake_update');
    // On a store whose wakes are being cut off, sources that say `first` (the record store's merges, which every other
    // read pays for) are read and run before any other source is read (invariant 11).
    const every = listed();
    const firsts = strained ? every.filter(source => source.first) : [];
    const passes = firsts.length && firsts.length < every.length ? [firsts, every.filter(source => !source.first)] : [null];
    const ran = [];
    const settling = new Set();
    const problems = [];
    const waiting = [];
    const allDue = [];
    // A due item keeps the wake time it started waiting at, so a source whose due time is re-read as now still ages.
    const waitingSince = record.waiting_since ?? {};
    record.waiting_since = {};
    const agingMs = limits.aging_seconds * 1000;
    let attempted = 0;
    const wallMs = limits.max_wall_ms;
    const costliest = {};
    let heavyLeft = cold ? limits.cold_heavy_runs ?? Infinity : Infinity;
    cold = false;
    for (const only of passes) {
      const gathered = await gather(at, record, false, only);
      const { answer, owner, actions, starts } = gathered;
      problems.push(...gathered.problems);
      waiting.push(...gathered.waiting);
      const skipped = new Set();
      for (const materialization of answer.materializations) {
        const { schedule_id } = materialization.occurrence;
        const source = owner.get(`schedule:${schedule_id}`);
        try { await source.materialized?.(materialization); } catch (error) {
          skipped.add(schedule_id);
          problems.push(setAside(record, waiting, `${source.name}|schedule:${schedule_id}`, { source: source.name, schedule_id, stage: 'run' }, error, at));
        }
      }
      const due = [
        ...answer.recurring_due.filter(occurrence => !skipped.has(occurrence.schedule_id)).map(occurrence => ({ source: owner.get(`schedule:${occurrence.schedule_id}`), key: `schedule:${occurrence.schedule_id}`, at: Date.parse(occurrence.start), occurrence })),
        ...answer.scheduled_due.map(fire => ({ source: owner.get(`action:${fire.record_id}`), key: `action:${fire.record_id}`, at: Date.parse(fire.due_at), fire })),
      ];
      for (const item of due) {
        const waitKey = `${item.source.name}|${item.key}`;
        item.since = Math.min(at, waitingSince[waitKey] ?? item.at);
        record.waiting_since[waitKey] = item.since;
      }
      const rank = item => (item.source.priority ?? 0) + Math.min(limits.max_aging_steps ?? Infinity, Math.floor(Math.max(0, at - item.since) / agingMs));
      due.sort((left, right) => rank(right) - rank(left) || left.since - right.since);
      allDue.push(...due);
      const taken = due.slice(0, Math.max(0, limits.most_runs - attempted));
      for (const item of taken) {
        // A long source must not start every other due source in the same alarm. The rest stays due.
        if (attempted && now() - at >= wallMs) break;
        // A wake run inside an admitted bound (a metered command's credit) starts no source its remaining room cannot hold,
        // judged by the costliest source already run in this wake, per measure the sources consume: the rest stays due for the next wake instead of every
        // one after the bound fails with it. The first source of a wake always runs.
        const room = attempted ? headroom() : null;
        if (room && Object.entries(room).some(([measure, left]) => (costliest[measure] ?? 0) > 0 && (left <= 0 || costliest[measure] > left))) break;
        const { source, occurrence, fire } = item;
        if (source.heavy && heavyLeft <= 0) continue;
        if (source.heavy) heavyLeft -= 1;
        attempted += 1;
        const key = `${source.name}|${item.key}`;
        const fields = { source: source.name, ...(occurrence ? { schedule_id: occurrence.schedule_id } : { record_id: fire.record_id }), stage: 'run' };
        console.log('scheduler starting', source.name);
        // Charged before it runs, and the charge is on disk before the run starts: a run the platform ends (out of
        // memory, a reset) never reaches the catch below, and without this charge it would be due again a second later,
        // forever. A run that returns clears it; one that throws replaces it with its own error, counted once.
        const before = record.entries[key];
        setAside(record, [], key, fields, CUT_OFF, at, { quiet: true });
        record.entries[key].charge = { before: before ?? null };
        const charged = JSON.stringify(record.entries[key]);
        const chargeStarted = performance.now();
        try { await kept.write(record); } catch (error) { problems.push(setAside(record, waiting, key, fields, error, at, { earlier: before })); continue; }
        // A concurrent owner change wins over this snapshot; never dispatch without our own durable charge.
        if (JSON.stringify(record.entries[key]) !== charged) continue;
        const chargeMs = performance.now() - chargeStarted;
        if (chargeMs >= 1000) trace('scheduler slow source', { source: source.name, stage: 'charge', duration_ms: Math.round(chargeMs) });
        running.add(key);
        let ranWell = false;
        const runStarted = performance.now();
        const began = now();
        const roomBefore = headroom();
        const stage = { budget_ms: stageMs, left: () => Math.max(0, began + stageMs - now()) };
        // What the run returned: whether it made progress (invariant 12).
        let returned = null;
        try {
          if (occurrence) {
            returned = await step(`${source.name}:run`, () => source.run(occurrence.action.owner_dispatch, occurrence, stage));
            await source.proven?.(occurrence, { proven: true, owner_ref: occurrence.action.owner_ref, proof_ref: String(returned?.proof_ref ?? occurrence.occurrence_key), observed_at: iso(now()) });
            ran.push({ source: source.name, schedule_id: occurrence.schedule_id, start: occurrence.start });
          } else {
            const action = actions.get(fire.record_id);
            returned = await step(`${source.name}:run`, () => source.run(action.dispatch, fire, stage));
            await source.fired?.(fire, action, returned);
            ran.push({ source: source.name, record_id: fire.record_id, due_at: fire.due_at });
          }
          delete record.entries[key];
          record.waiting_since[key] = at;
          ranWell = true;
        } catch (error) {
          const problem = setAside(record, waiting, key, fields, error, at, { earlier: before });
          problems.push(problem);
          // A source whose items wait in a queue it reads earliest first moves the failed one back to its retry time, so a
          // run of failing items never holds the front of the queue from the ones behind them.
          if (fire) { try { await source.failed?.(fire, actions.get(fire.record_id), problem); } catch (reported) { console.error('scheduler', key, 'failed hook', withoutSecrets(reported)); } }
        } finally {
          const duration = performance.now() - runStarted;
          const roomAfter = roomBefore ? headroom() : null;
          if (roomBefore && roomAfter) {
            const cost = {};
            for (const [measure, left] of Object.entries(roomBefore)) { cost[measure] = left - (roomAfter[measure] ?? left); costliest[measure] = Math.max(costliest[measure] ?? 0, cost[measure]); }
            trace('scheduler source cost', { source: source.name, rows_read: cost.rows_read ?? null, statements: cost.statements ?? null, rows_written: cost.rows_written ?? null, room_rows_read: roomAfter.rows_read ?? null });
          }
          if (ranWell && fire && starts.has(key)) {
            if (returned?.progress !== false) stalled.delete(key);
            else {
              const streak = (stalled.get(key)?.streak ?? 0) + 1, until = now() + stallWait(streak);
              stalled.set(key, { due: starts.get(key), streak, until });
              trace('scheduler waits after a run that made no progress', { key, streak, in_ms: until - now() });
            }
          }
          const share = shares[source.name];
          if (share) {
            restUntil.set(source.name, now() + Math.max(duration, now() - began, share.floor_ms) * (3600 / share.seconds_per_hour - 1));
            const generation = restInputGeneration;
            dueAtRestEnd.set(source.name, { generation, due: await hasDueWork(source) });
          }
          // Until its outcome is durable, another arm must still recognize this charge as owned here.
          settling.add(key);
          if (duration >= 1000) trace('scheduler slow source', { source: source.name, stage: 'run', duration_ms: Math.round(duration), ...(duration > stageMs ? { over_budget_ms: Math.round(duration - stageMs) } : {}) });
        }
      }
      // What the first pass ran is kept before any other source is read, so a later read that resets the store
      // cannot charge a run that already finished.
      if (only && attempted) await kept.write(record);
    }
    const due = allDue;
    const oldest = due.length ? Math.min(...due.map(item => item.at)) : null;
    // The wake answers its own count: the write below adopts the stored record, and a wake that emptied its store (an
    // account's last delete slice drops every table) adopts one without last_wake.
    const left = due.length - attempted;
    record.last_wake = { at: iso(at), due: due.length, ran: ran.length, failed: problems.length, left, oldest_due_age_ms: oldest === null ? null : Math.max(0, at - oldest) };
    try { await kept.write(record); }
    finally { for (const key of settling) running.delete(key); }
    // Requests after this point inspect their new changes themselves instead of relying on our earlier read.
    deferArmRequests = false;
    const armed = await arm({ fromWake: true, finishedWake: unfinished });
    return { ran, problems, left, ...armed };
  }

  // Kept as the platform's alarm first reaches the host, before anything the host does ahead of the wake: an
  // alarm_entered later than wake_started is an alarm that stopped before its wake began.
  async function entered() {
    const token = crypto.randomUUID();
    await kept.update(record => {
      record.alarm_entered = iso(now());
      record.unfinished_wake = token;
    }, 'scheduler_entry');
    return token;
  }

  // Every set-aside and held entry, and the last wake's counts.
  async function status() {
    const record = await readRecord();
    const entries = Object.values(record.entries).map(({ charge, ...entry }) => ({ ...entry, retry_at: entry.retry_at === null ? null : iso(entry.retry_at) }));
    const failed = entries.filter(entry => !running.has(entry.key));
    const going = entries.filter(entry => running.has(entry.key)).map(({ key, source, schedule_id, record_id, last_failed_at }) => ({ key, source, ...(schedule_id ? { schedule_id } : { record_id }), started_at: last_failed_at }));
    // When the alarm is set for now, read from the platform itself: an alarm that never fires shows here as a time long past.
    const alarmAt = (await alarm.getAlarm?.()) ?? null;
    return { failed, running: going, reading: [...reading.values()].map(entry => ({ ...entry })), held: failed.filter(entry => entry.held).length, wake_incomplete: Boolean(record.unfinished_wake), last_wake: record.last_wake ?? null, wake_started: record.wake_started ?? null, alarm_entered: record.alarm_entered ?? null, alarm_at: alarmAt === null ? null : iso(alarmAt) };
  }

  // Tries again now what was set aside or held: all of those entries, one source (`name`), or one entry (`key`).
  // An active run already owns its charge; changing it here would invalidate that run's eventual settlement.
  async function retryNow({ name = null, key = null } = {}) {
    const at = now();
    const record = await readRecord();
    const released = [];
    for (const entry of Object.values(record.entries)) {
      if (running.has(entry.key)) continue;
      if ((key && entry.key !== key) || (name && entry.key.split('|')[0] !== name)) continue;
      record.entries[entry.key] = { ...entry, held: false, failures: 0, retry_at: at };
      released.push(entry.key);
      // An explicit retry also ends the source's rest after its failed run, or the released work would wait it out.
      restUntil.delete(entry.key.split('|')[0]);
      dueAtRestEnd.delete(entry.key.split('|')[0]);
    }
    // An explicit retry also ends the waits of runs that made no progress (invariant 12).
    for (const stallKey of [...stalled.keys()]) if ((!key || stallKey === key) && (!name || stallKey.split('|')[0] === name)) { stalled.delete(stallKey); released.push(stallKey); }
    await kept.write(record);
    // An explicit retry promises to inspect the released source before returning;
    // a foreground planner's older snapshot cannot fulfill that request.
    return { released, ...(await arm({ refresh: true })) };
  }

  return { wake, arm, entered, status, retry: retryNow };
}
