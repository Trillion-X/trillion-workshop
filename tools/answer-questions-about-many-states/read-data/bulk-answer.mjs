// tools/answer-questions-about-many-states/read-data/bulk-answer.mjs
//
// The four rows' functions, each called by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }). Every
// input is read from the person's rows and every outcome is written as rows, through the records door the run is
// given, so a run is read and cancelled from any computer and nothing a run keeps lives in a folder.
//
//   getAClassifierReady({ model })                          the model row's weights fetched, checked and named; the
//                                                           naming kept as a classifier-ready row
//   answerManyStates({ model, questions, settings, states }) the whole run: inputs read by record id, the states
//                                                           answered on this Mac by do-work/answer_many_states.py, the
//                                                           run's status and its answers written as rows as it goes
//   readABulkAnswerRun({ job_id, page? })                   status, and one page of answers
//   cancelABulkAnswerRun({ job_id })                        asks the run to stop after the batch in hand
//
// The rows this keeps (record_model in tool-rows.json):
//   bulk-answer-run:<job hex>             { job_id, attempt, status, states_done, states, pages, ... }, one per run
//   bulk-answer-page:<job hex>:<000000>   { job_id, attempt, page, answers: [{ state, index, answers }] }, each at most
//                                         settings.page_bytes of answers, so a page and its run row fit one message
//   bulk-answer-cancel:<job hex>          { job_id, attempt, asked_at }, the stop a cancel asks for
//   classifier-ready:<model hex>          { model, classifier, identity, files, ready_at }
// The job id is the BLAKE3 identity of what was read (the model row, the questions, the states with their ids, the
// settings), so the same rows name the same run, wherever it is started. Every write carries a request key made from
// the job, the attempt and what it writes, so a write sent again is the same write.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

export const RUN = 'bulk-answer-run';
export const PAGE = 'bulk-answer-page';
export const CANCEL = 'bulk-answer-cancel';
export const READY = 'classifier-ready';
// The row's invoke.max_run_ms: a run row still `running` after this long was ended by the engine.
export const LONGEST_RUN_MS = 14_400_000;
// A running run writes its run row at least this often, and one not written for STALE_MS has stopped (its computer
// slept or crashed), so the same request may start it again.
export const HEARTBEAT_MS = 60_000;
export const STALE_MS = 300_000;
// The most bytes of answers one page row holds: with its run row it fits one records-door message (64 KiB).
export const MOST_PAGE_BYTES = 56_000;
const SETTINGS = ['layout', 'dtype', 'tokens_per_batch', 'max_state_tokens', 'page_bytes'];
const WORKER = fileURLToPath(new URL('../do-work/answer_many_states.py', import.meta.url));
const utf8 = new TextEncoder();
const bytesOf = value => utf8.encode(JSON.stringify(value)).length;

class Refusal extends Error {}

export const hexOf = jobId => {
  if (typeof jobId !== 'string' || !/^1f:[0-9a-f]{64}$/.test(jobId)) throw new Refusal('`job_id` is the 1f:<64 hex> the run answered');
  return jobId.slice(3);
};
export const runId = hex => `${RUN}:${hex}`;
export const pageId = (hex, page) => `${PAGE}:${hex}:${String(page).padStart(6, '0')}`;
export const cancelId = hex => `${CANCEL}:${hex}`;

// ---- reading the inputs

function address(input, field, { prefix = false } = {}) {
  const value = input?.[field];
  const wanted = prefix ? '{ type, prefix, field? }' : '{ type, id }';
  if (!value || typeof value !== 'object' || typeof value.type !== 'string' || !value.type
    || (prefix ? typeof value.prefix !== 'string' || !value.prefix : typeof value.id !== 'string' || !value.id)) {
    throw new Refusal(`\`${field}\` is the ${prefix ? 'rows' : 'row'} to read, as ${wanted}`);
  }
  if (prefix && value.field !== undefined && (typeof value.field !== 'string' || !value.field)) throw new Refusal('`states.field` names the field of each row that holds its state');
  return value;
}

async function readRow(door, { type, id }, what) {
  const value = await door.read(type, id);
  if (value === null) throw new Refusal(`${what} ${id} (${type}) is not in the person's records`);
  return value;
}

function checkSettings(settings) {
  for (const field of SETTINGS) if (!(field in settings)) throw new Refusal(`the settings row has no \`${field}\``);
  if (!Number.isInteger(settings.page_bytes) || settings.page_bytes < 1 || settings.page_bytes > MOST_PAGE_BYTES) {
    throw new Refusal(`the settings row's \`page_bytes\` must be a whole number from 1 to ${MOST_PAGE_BYTES}, so an answer row fits one records-door message`);
  }
}

// -> { model, questions, settings, states: [{ id, state }] } read through the door, and the job id they name.
export async function readInputs(input, door) {
  const where = { model: address(input, 'model'), questions: address(input, 'questions'), settings: address(input, 'settings'), states: address(input, 'states', { prefix: true }) };
  const model = await readRow(door, where.model, 'the model row');
  const set = await readRow(door, where.questions, 'the question set');
  if (!set.questions || typeof set.questions !== 'object' || Array.isArray(set.questions)) throw new Refusal(`the question set ${where.questions.id} holds no \`questions\` map {question id: {type, instructions, criteria?}}`);
  const settings = await readRow(door, where.settings, 'the settings row');
  checkSettings(settings);
  const states = [];
  for await (const row of door.list({ type: where.states.type, prefix: where.states.prefix })) {
    if (!row.id.startsWith(where.states.prefix)) continue;
    const field = where.states.field;
    if (field !== undefined && !(row.value && typeof row.value === 'object' && field in row.value)) throw new Refusal(`the state row ${row.id} has no \`${field}\``);
    states.push({ id: row.id, state: field === undefined ? row.value : row.value[field] });
  }
  if (!states.length) throw new Refusal(`no ${where.states.type} rows start with ${where.states.prefix}: give the prefix of the rows to ask about`);
  states.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const jobId = makeHashCodeHexFromJson({ model: { id: where.model.id, value: model }, questions: set.questions, settings, states: states.map(({ id, state }) => [id, state]) });
  return { where, model: { ...model, id: model.id ?? where.model.id }, questions: set.questions, settings, states, jobId };
}

// ---- the programs this starts

// The worker as a child: standard input the request, standard output its JSON lines. Tests hand in their own `start`.
// -B: Python writes no compiled copy (__pycache__) of the modules it imports, so a run leaves the tool's folder as it was.
export function startWorker(action, request, { python = 'python3', worker = WORKER } = {}) {
  const child = spawn(python, ['-I', '-B', worker, action], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(request));
  return child;
}

const lineOf = text => { try { return JSON.parse(text); } catch { return null; } };

async function lastLine(child) {
  let last = null;
  for await (const text of createInterface({ input: child.stdout })) last = lineOf(text) ?? last;
  const code = await new Promise(done => (child.exitCode !== null ? done(child.exitCode) : child.on('close', done)));
  return { last, code };
}

// ---- the rows

export async function getAClassifierReady(input, { door }, { start = startWorker } = {}) {
  const where = address(input, 'model');
  const model = await readRow(door, where, 'the model row');
  const { last } = await lastLine(start('get-ready', { model: { ...model, id: model.id ?? where.id } }));
  if (!last || last.error || !last.result) throw new Refusal(last?.error ?? 'the classifier program printed no answer');
  const ready = { model: where, classifier: last.result.classifier, identity: last.result.identity, files: last.result.files, ready_at: new Date().toISOString() };
  const id = `${READY}:${makeHashCodeHexFromJson(where).slice(3)}`;
  await door.write([{ id, type: READY, value: ready }], { key: `${id}:${last.result.identity}` });
  return { ...ready, ready: true, record: { id, type: READY } };
}

// A run row still running, written by a run that may still be going: written lately, and inside its longest time.
const stillGoing = (run, now) => run?.status === 'running' && Date.parse(run.longest_until) > now && now - Date.parse(run.updated_at) < STALE_MS;

export async function answerManyStates(input, { door }, { start = startWorker, pollMs = 2000, now = () => Date.now() } = {}) {
  const read = await readInputs(input, door);
  const hex = read.jobId.slice(3);
  const id = runId(hex);
  const before = await door.read(RUN, id);
  if (before && (before.status === 'finished' || before.status === 'cancelled' || stillGoing(before, now()))) {
    return { job_id: read.jobId, status: before.status, states_done: before.states_done, states: before.states, pages: before.pages, already: true };
  }
  const attempt = randomUUID();
  const key = what => `${RUN}:${hex}:${attempt}:${what}`;
  const begun = new Date(now());
  const run = {
    job_id: read.jobId, attempt, status: 'running', states_done: 0, states: read.states.length, pages: 0,
    model: read.where.model, questions: read.where.questions, settings: read.where.settings, states_from: read.where.states,
    question_ids: Object.keys(read.questions), layout: read.settings.layout,
    started_at: begun.toISOString(), updated_at: begun.toISOString(), longest_until: new Date(begun.getTime() + LONGEST_RUN_MS).toISOString(),
  };
  const asRow = () => ({ id, type: RUN, value: { ...run, updated_at: new Date(now()).toISOString() } });
  // One write at a time, in order, so the run row never goes back to an earlier count.
  let queue = Promise.resolve(), wrote = now(), beats = 0;
  const send = (records, what) => (queue = queue.then(() => { wrote = now(); return door.write(records(), { key: key(what) }); }));
  // A stop asked of an earlier attempt is not this attempt's.
  if (await door.read(CANCEL, cancelId(hex)) !== null) await door.write([{ id: cancelId(hex), type: CANCEL, value: null }], { key: key('clear-cancel') });

  const child = start('work', { model: read.model, questions: read.questions, settings: read.settings, states: read.states.map(s => s.state) });
  let stopAsked = false;
  const poll = setInterval(async () => {
    if (checked && now() - wrote >= HEARTBEAT_MS) send(() => [asRow()], `beat:${beats++}`).catch(() => {});
    if (stopAsked) return;
    try {
      const asked = await door.read(CANCEL, cancelId(hex));
      if (asked && asked.attempt === attempt) { stopAsked = true; child.kill('SIGTERM'); }
    } catch { /* the next poll asks again */ }
  }, pollMs);
  poll.unref?.();

  let page = [], held = 0, last = null, checked = false;
  const flush = async () => {
    if (!page.length) return;
    const n = run.pages;
    run.pages += 1;
    run.states_done += page.length;
    const value = { job_id: read.jobId, attempt, page: n, answers: page };
    page = []; held = 0;
    await send(() => [{ id: pageId(hex, n), type: PAGE, value }, asRow()], `page:${n}`);
  };
  try {
    for await (const text of createInterface({ input: child.stdout })) {
      const line = lineOf(text);
      if (!line) continue;
      last = line;
      if (line.checked && !checked) {
        checked = true;
        await send(() => [asRow()], 'running');
      } else if (Array.isArray(line.answered)) {
        for (const { state, answers } of line.answered) {
          const entry = { state: read.states[state].id, index: state, answers };
          const size = bytesOf(entry) + 1;
          if (size > read.settings.page_bytes) throw new Refusal(`the answers of ${entry.state} take ${size} bytes, more than the settings row's page_bytes (${read.settings.page_bytes}); raise it, up to ${MOST_PAGE_BYTES}`);
          if (held + size > read.settings.page_bytes) await flush();
          page.push(entry);
          held += size;
        }
      }
    }
    const code = await new Promise(done => (child.exitCode !== null ? done(child.exitCode) : child.on('close', done)));
    if (!checked) throw new Refusal(last?.error ?? `the classifier program ended (${code}) before it read the request`);
    await flush();
    if (code !== 0 || !last?.result) {
      Object.assign(run, { status: 'failed', error: last?.error ?? `the classifier program ended (${code}) without its last line` });
    } else {
      Object.assign(run, { status: stopAsked || last.result.status === 'cancelled' ? 'cancelled' : 'finished', classifier_answers_as: last.result.classifier_answers_as, seconds: last.result.seconds });
    }
    await send(() => [asRow()], run.status);
    return { job_id: read.jobId, status: run.status, states_done: run.states_done, states: run.states, pages: run.pages, ...(run.error ? { error: run.error } : {}) };
  } catch (error) {
    child.kill('SIGTERM');
    if (checked) {
      Object.assign(run, { status: 'failed', error: error.message });
      await queue.catch(() => {});
      queue = Promise.resolve();
      await send(() => [asRow()], 'failed').catch(() => {});
    }
    throw error;
  } finally {
    clearInterval(poll);
  }
}

// What a reader is told of a run row: a run still `running` past its longest time was ended without finishing.
function shown(run, now) {
  if (run.status === 'running' && !stillGoing(run, now)) return { ...run, status: 'failed', error: 'the run stopped without finishing (its computer slept or crashed, or it passed its longest time); start it again with the same rows' };
  return run;
}

async function runOf(door, jobId) {
  const hex = hexOf(jobId);
  const run = await door.read(RUN, runId(hex));
  if (run === null) throw new Refusal(`no run ${jobId} in the person's records: start it with tool:answer-questions-about-many-states`);
  return { hex, run };
}

export async function readABulkAnswerRun(input, { door }, { now = () => Date.now() } = {}) {
  const { hex, run: kept } = await runOf(door, input?.job_id);
  const run = shown(kept, now());
  const out = Object.fromEntries(['job_id', 'status', 'states_done', 'states', 'pages', 'layout', 'question_ids', 'classifier_answers_as', 'seconds', 'error', 'started_at', 'updated_at']
    .filter(field => run[field] !== undefined).map(field => [field, run[field]]));
  if (input.page === undefined) return out;
  if (!Number.isInteger(input.page) || input.page < 0 || input.page >= run.pages) {
    throw new Refusal(run.pages ? `\`page\` must be a whole number from 0 to ${run.pages - 1}` : 'the run has written no answers yet: read it again later');
  }
  const value = await door.read(PAGE, pageId(hex, input.page));
  if (value === null || value.attempt !== run.attempt || value.job_id !== run.job_id) throw new Refusal(`page ${input.page} of ${run.job_id} is not in the person's records`);
  return { ...out, page: { index: input.page, answers: value.answers, next_page: input.page + 1 < run.pages ? input.page + 1 : null } };
}

export async function cancelABulkAnswerRun(input, { door }, { now = () => Date.now() } = {}) {
  const { hex, run } = await runOf(door, input?.job_id);
  const answer = status => ({ job_id: run.job_id, status, states_done: run.states_done, states: run.states, pages: run.pages });
  if (run.status !== 'running') return answer(run.status);
  if (!stillGoing(run, now())) {
    // Nothing is running it any more: the run row itself says it stopped, if it is still the row read here.
    await door.write([{ id: runId(hex), type: RUN, value: { ...run, status: 'cancelled', updated_at: new Date(now()).toISOString() }, expected: { type: RUN, value: run } }], { key: `${CANCEL}:${hex}:${run.attempt}:ended` });
    return answer('cancelled');
  }
  await door.write([{ id: cancelId(hex), type: CANCEL, value: { job_id: run.job_id, attempt: run.attempt, asked_at: new Date(now()).toISOString() } }], { key: `${CANCEL}:${hex}:${run.attempt}` });
  return answer('cancelling');
}
