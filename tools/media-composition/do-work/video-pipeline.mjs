/**
 * file: parts/media-composition/do-work/video-pipeline.mjs
 *
 * PURPOSE: Runs long video work as named stages that can be stopped and started again. Every run is one file (its REPORT) that
 * says which stage is done, running, failed or waiting, what each stage produced, how many tries it took, and what was proposed,
 * refined and applied, so a run can be shown honestly while it works, resumed after the Mac restarts, and replayed in a test.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Blind: stages, retry counts, what must be confirmed before space is freed, and the words are rows of video-pipeline.json.
 *    Handlers (detect, cut, render, upload ...) are handed in; this file names none and knows no format.
 * 2. The report is written before a stage starts (state running) and after it ends, atomically, so a stop at any moment leaves
 *    a file that says exactly where it stopped. Starting again never repeats a done stage and finalizes a half-done one first.
 * 3. Progress is honest: the share of finished stage weight plus the running stage's own reported part; it reaches 100 only when
 *    every stage is done.
 * 4. A stage with `requires` never runs until the earlier stage's result holds the required value; it is `blocked`, with words.
 * 5. A failure that says retry:false is not tried again; one that may be, is tried again as a recorded attempt up to `retry.max`.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import defaults from './video-pipeline.json' with { type: 'json' };

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 404) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The pipeline over a folder of reports. `handlers` is { [stage id or finalize name]: async (context) => result }. */
export function makeVideoPipeline({ config = defaults, home = homedir(), handlers = {}, now = () => Date.now(), wait = sleep } = {}) {
  const dir = join(home, config.report_dir);
  const fileOf = id => join(dir, `${id}.json`);
  const save = run => { mkdirSync(dir, { recursive: true, mode: 0o700 }); const next = `${fileOf(run.id)}.next`; writeFileSync(next, JSON.stringify(run, null, 1), { mode: 0o600 }); renameSync(next, fileOf(run.id)); };
  const load = id => { try { return JSON.parse(readFileSync(fileOf(id), 'utf8')); } catch { throw refusal(fill(config.words.unknown_run, { id })); } };
  const pipelineOf = id => config.pipelines.find(row => row.id === id) ?? (() => { throw refusal(fill(config.words.unknown_pipeline, { id })); })();
  const log = (run, stage, to, extra = {}) => run.history.push({ at: new Date(now()).toISOString(), stage, to, ...extra });

  /** Honest progress of a run: { percent, stage (the name now), said }. */
  function progress(run) {
    const rows = pipelineOf(run.pipeline).stages;
    const total = rows.reduce((sum, row) => sum + (row.weight ?? 1), 0);
    const done = rows.reduce((sum, row) => sum + (run.stages[row.id].state === 'done' ? (row.weight ?? 1) : 0), 0);
    const active = rows.find(row => run.stages[row.id].state === 'running');
    const part = active ? (row => Math.min(0.99, Math.max(0, run.stages[row.id].progress ?? 0)) * (row.weight ?? 1))(active) : 0;
    const percent = run.state === 'done' ? 100 : Math.min(99, Math.floor(((done + part) / total) * 100));
    const named = active ?? rows.find(row => run.stages[row.id].state !== 'done');
    return { percent, stage: named?.name ?? null, said: run.state === 'done' ? config.words.done : fill(config.words.working, { stage: named?.name ?? '', percent }) };
  }

  const blockedBy = (run, row) => {
    const need = row.requires;
    if (!need) return null;
    return run.stages[need.stage]?.result?.[need.field] === need.equals ? null : need;
  };

  async function runStages(run) {
    const pipeline = pipelineOf(run.pipeline);
    run.state = 'running'; save(run);
    for (const row of pipeline.stages) {
      const stage = run.stages[row.id];
      if (stage.state === 'done') continue;
      if ((row.needs ?? []).some(id => run.stages[id].state !== 'done')) { stage.state = 'waiting'; continue; }
      const need = blockedBy(run, row);
      if (need) {
        stage.state = 'blocked'; stage.reason = fill(config.words.blocked, { stage: row.name, needs: pipeline.stages.find(item => item.id === need.stage)?.name ?? need.stage, field: need.field, equals: need.equals });
        log(run, row.id, 'blocked'); run.state = 'blocked'; save(run); return run;
      }
      const handler = handlers[row.id];
      if (typeof handler !== 'function') { stage.state = 'failed'; stage.error = fill(config.words.no_handler, { stage: row.name }); run.state = 'failed'; save(run); return run; }
      for (let attempt = (stage.attempts ?? 0) + 1; ; attempt += 1) {
        stage.state = 'running'; stage.attempts = attempt; stage.started = new Date(now()).toISOString(); delete stage.error; delete stage.reason;
        log(run, attempt > 1 ? `${row.id}:retry` : row.id, 'running', { attempt }); save(run);
        try {
          const context = {
            run, stage, input: run.input, results: Object.fromEntries(Object.entries(run.stages).map(([id, value]) => [id, value.result])),
            setProgress: part => { stage.progress = part; save(run); },
            plan: (kind, value) => { run.plans[kind] = value; save(run); },
          };
          stage.result = (await handler(context)) ?? {};
          stage.state = 'done'; stage.progress = 1; stage.finished = new Date(now()).toISOString(); log(run, row.id, 'done'); save(run);
          break;
        } catch (error) {
          stage.error = fill(config.words.failed, { stage: row.name, error: String(error?.message ?? error).slice(0, 300) });
          const again = error?.retry !== false && attempt <= (row.retry?.max ?? 0);
          log(run, row.id, again ? 'retrying' : 'failed', { attempt, error: stage.error }); save(run);
          if (!again) { stage.state = 'failed'; run.state = 'failed'; save(run); return run; }
          await wait(row.retry.wait_ms ?? 0);
        }
      }
    }
    run.state = pipeline.stages.every(row => run.stages[row.id].state === 'done') ? 'done' : run.state;
    save(run);
    return run;
  }

  return {
    /** Starts a run of a pipeline on an input and runs it; the report's id is returned in the answer. */
    async start({ pipeline, input = {} }) {
      const rows = pipelineOf(pipeline).stages;
      const created = now();
      const run = { id: `run-${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([pipeline, input, created]))).slice(3, 19)}`, pipeline, input, created: new Date(created).toISOString(), state: 'new',
        stages: Object.fromEntries(rows.map(row => [row.id, { name: row.name, state: 'waiting', attempts: 0 }])), plans: {}, history: [] };
      save(run);
      return this.report(await runStages(run));
    },
    /** Continues a run from the first stage that is not done; a stage left running by a stop is finalized first. */
    async resume(id) {
      const run = load(id);
      const pipeline = pipelineOf(run.pipeline);
      for (const row of pipeline.stages) {
        const stage = run.stages[row.id];
        if (stage.state !== 'running') continue;
        stage.state = 'interrupted'; stage.reason = fill(config.words.interrupted, { stage: row.name });
        log(run, row.id, 'interrupted');
        if (row.finalize && typeof handlers[row.finalize] === 'function') { stage.finalized = (await handlers[row.finalize]({ run, stage, input: run.input })) ?? {}; log(run, row.id, 'finalized'); }
        stage.attempts = Math.max(0, stage.attempts - 1);
      }
      save(run);
      return this.report(await runStages(run));
    },
    /** Runs left half done by a stop: the ones to resume at the next start. */
    interrupted() {
      try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))).filter(run => ['running', 'blocked', 'failed'].includes(run.state)).map(run => ({ id: run.id, state: run.state, ...progress(run) })); }
      catch { return []; }
    },
    report(run) { return { id: run.id, state: run.state, ...progress(run), stages: run.stages, plans: run.plans, history: run.history }; },
    get: id => { const run = load(id); return { id: run.id, state: run.state, ...progress(run), stages: run.stages, plans: run.plans, history: run.history }; },
    /** The plans of a run (proposed, refined, applied) and the history, for audit and replay. */
    replay(id) { const run = load(id); return { input: run.input, plans: run.plans, history: run.history }; },
  };
}

/**
 * Sends bytes in numbered parts and records each part's state in the stage result, so a stopped upload sends only the parts the
 * server has not confirmed. `send(number, offset, length)` returns true once the server has confirmed that part. The result's
 * `confirmed` is true only when every part is confirmed, which is what lets `free_local` run.
 */
export async function uploadInParts({ size, part_size, previous = null, send }) {
  const total = Math.max(1, Math.ceil(size / part_size));
  const parts = Array.from({ length: total }, (_, index) => previous?.parts?.[index] ?? { n: index + 1, state: 'waiting' });
  for (const part of parts) {
    if (part.state === 'confirmed') continue;
    const offset = (part.n - 1) * part_size;
    part.state = (await send(part.n, offset, Math.min(part_size, size - offset))) === true ? 'confirmed' : 'sent';
  }
  return { parts, total, confirmed: parts.every(part => part.state === 'confirmed') };
}
