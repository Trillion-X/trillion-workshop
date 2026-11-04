// computer/local-models.mjs
//
// Purpose
//   Answers a model call for the person's Trillion with a model served on this computer, so work that needs a model
//   (checking answers, telling chatter from requests) costs nobody anything: tool:ask-a-model, run by
//   computer/mac-tools.mjs on placement:your-computer (src/model-routes.json sends calls here before any paid service).
//
// Non-negotiable invariants
//   1. Which servers and models answer is DATA (computer/local-models.json and records/local-model-records.json); this file names none.
//      The model rows are the ones the Marketplace publishes now, read through the computer's account (local-models.json
//      `published`) and kept here, so a computer that cannot reach its account still answers with the rows it last read;
//      the rows it was shipped with stand until the default publisher has published them.
//   2. Only this computer's own servers are asked; the words never leave it except as the answer.
//   3. A server that is not running is skipped; when none answers the tool says so in words (error), and Trillion tries
//      its next route rather than waiting, and names for each model why it did not answer (`tried`). A model that refused
//      only this request's shape (400-499, such as a model that takes no tool calls) is passed over for that request and
//      not rested, so one request it cannot take never silences the asks it can.
//   4. tool:get-free-models (modelsForThisMac) reads this Mac (its chip, memory and free space) and the models
//      its server has, and offers only models that fit (DATA `offer`); asked to get them, it puts the server on the
//      Mac when it is missing and has the server download each, so the person never installs or types anything.
//
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mergeEvent, newEntry } from '../stream-an-answer-in-keyed-parts/src/keyed-parts.mjs';
import { withTables } from '../src/data-rows.mjs';
import { makeHelperRuntimes } from './helper-runtimes.mjs';
import { makeFastPathMeter } from './fast-path-meter.mjs';
import { readManagedSettings, turnedOff } from './managed-settings.mjs';
import modelRecords from '../records/local-model-records.json' with { type: 'json' };
import decisionEvals from '../src/decision-evals.json' with { type: 'json' };
import { readOffered } from './offered-endpoints.mjs';
import { marketplaceContentSourceId } from '../src/marketplace-content-source-id.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const settingsFile = () => JSON.parse(readFileSync(join(HERE, 'local-models.json'), 'utf8'));
const home = path => path.replace(/^~(?=\/|$)/, homedir());
const keptAt = published => home(published.kept_copy);
function readKept(published) {
  try {
    const kept = JSON.parse(readFileSync(keptAt(published), 'utf8'));
    return kept?.logical_id === marketplaceContentSourceId(published) ? kept : null;
  } catch { return null; }
}

/** The model rows this computer uses now, as a records file ({ records }): the rows its account last said the Marketplace
 *  publishes, none once they were withdrawn, and the rows it was shipped with until either. */
export function currentModelRecords(published = settingsFile().published) {
  const kept = readKept(published);
  if (kept?.from === 'published' && Array.isArray(kept.value)) return { records: kept.value };
  if (kept?.from === 'withdrawn') return { records: [] };
  return modelRecords;
}

let reading = null;
/** Asks this computer's account ({ origin, key }) which model rows the Marketplace publishes now, at most once every
 *  `fresh_seconds`, and keeps the answer for currentModelRecords. An account that cannot be reached, or an answer that
 *  is not an exact published section, leaves the kept rows as they are. Resolves true when it kept a new answer. */
export function refreshModelRecords({ origin, key } = {}, { published = settingsFile().published, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!origin || !key) return Promise.resolve(false);
  const logical_id = marketplaceContentSourceId(published), kept = readKept(published);
  if (kept && now() - Date.parse(kept.read_at) < published.fresh_seconds * 1000) return Promise.resolve(false);
  reading ??= (async () => {
    try {
      const answer = await fetchImpl(`${String(origin).replace(/\/$/, '')}/mcp/api/resources/own/command`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(published.wait_seconds * 1000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-trillion-request-key': `marketplace-read:${randomUUID()}` },
        body: JSON.stringify({ operation: 'content:default', input: { logical_id } }) });
      if (!answer.ok) return false;
      const body = await answer.json(), row = body?.row;
      const state = body?.published === true && row && (row.logical_id === undefined || row.logical_id === logical_id) && row.format === 'json'
        && Number.isSafeInteger(row.revision) && row.revision >= 1 && Array.isArray(row.value)
        ? { from: 'published', maker: body.maker ?? null, revision: row.revision, value: row.value }
        : body?.published === false ? { from: body.adopted === true ? 'withdrawn' : 'shipped' } : null;
      if (!state) return false;
      const file = keptAt(published), next = `${file}.${process.pid}.next`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(next, JSON.stringify({ logical_id, read_at: new Date(now()).toISOString(), ...state }));
      renameSync(next, file);
      return true;
    } catch { return false; }
    finally { reading = null; }
  })();
  return reading;
}

// The settings file with its model tables (chat, jobs, classify, offer) read from the local-model rows the computer uses
// now (currentModelRecords), and `wired`: each decision measured and wired to one classify judge (src/decision-evals.json),
// as { <decision id>: <classify row id> }.
export const localModelSettings = (records = currentModelRecords()) => ({ ...withTables(settingsFile(), {
  chat: { kind: 'local-model-server', records },
  jobs: { kind: 'local-model-job', records, keyed: true },
  classify: { kind: 'local-model-classifier', records },
  offer: { kind: 'local-model-offer', records },
}), offered: () => readOffered(), wired: Object.fromEntries(decisionEvals.evals.filter(row => row.wired).map(row => [row.id, row.wired.judge])) });

/** askLocal for this computer's person ({ origin, key }): the model rows are read afresh from the account first, when due. */
export const askHere = account => async (input, options) => { await refreshModelRecords(account); return askLocal(input, localModelSettings(), options); };

async function post(url, body, seconds, headers = {}) {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(seconds * 1000) });
  if (!answer.ok) throw Object.assign(new Error(`${url} answered ${answer.status}`), { status: answer.status });
  return answer.json();
}

// The chat asked with stream: true: each server-sent chunk is merged as a keyed text part (src/keyed-parts.mjs) so the answer is
// built part by part; the reply keeps the OpenAI shape and also carries the parts it was built from.
async function postStreaming(url, body, seconds, headers = {}) {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(seconds * 1000) });
  if (!answer.ok) throw Object.assign(new Error(`${url} answered ${answer.status}`), { status: answer.status });
  let entry = newEntry(), seq = 0, pending = '', model = null;
  const take = line => {
    const text = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!text || text === '[DONE]') return;
    const chunk = JSON.parse(text);
    model = chunk.model ?? model;
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) entry = mergeEvent(entry, { seq: (seq += 1), type: 'text', key: 'answer', text: piece });
  };
  const decoder = new TextDecoder();
  for await (const bytes of answer.body) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(take);
  }
  take(pending);
  return { model, choices: [{ message: { role: 'assistant', content: entry.parts.answer?.text ?? '' }, finish_reason: 'stop' }], parts: entry.parts, order: entry.order, seq: entry.seq };
}

// A busy or stopped model is tried again after a short pause, instead of making every waiting Mac job spend its full
// timeout on the same failure. The key is the local endpoint and model, so chat and classification share its state.
// A rest silences only asks no more important than the ask that caused it. A background judge timing out behind a busy
// queue must not make the model answer "resting" to the work the person's chosen AI is doing for them; that work tries
// the model itself, and its own failure rests the model for the asks beneath it.
// How each ask to a model row was served (first row, a later row, none), so a silent fallback is reported (fast-path-meter.json).
export const modelMeter = makeFastPathMeter();
const unavailableUntil = new Map();
const modelKey = row => `${row.url}\0${row.model ?? row.id}`;

// A server that refused this request's shape (400-499: the model takes no tool calls, the input is too long) is working;
// resting it would silence its other asks for the pause. Only silence, a failing server or a full queue rests a model.
const refusedTheAsk = error => error?.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
const whyNot = error => (error?.status ? `answered ${error.status}` : error?.name === 'TimeoutError' ? 'did not answer in time' : 'is not running');

/** Asks the first row of `rows` whose server answers; null when none does. `failures` (an array) is filled with each
 *  row passed over and why, so an empty result can say what happened. */
export async function firstAnswer(rows, ask, retryAfterSeconds = 0, failures = [], priority = 0, meterPath = 'local-model') {
  for (const row of rows) {
    const key = modelKey(row);
    const resting = unavailableUntil.get(key);
    if (resting && resting.until > Date.now() && priority <= resting.priority) { failures.push({ id: row.id, why: 'is resting after a failure' }); continue; }
    try {
      const reply = await ask(row);
      unavailableUntil.delete(key);
      modelMeter.record(meterPath, failures.length ? 'fallback' : 'served', failures[0] ? `${failures[0].id} ${failures[0].why}` : null);
      return { row, reply };
    } catch (error) {
      failures.push({ id: row.id, why: whyNot(error) });
      if (retryAfterSeconds > 0 && !refusedTheAsk(error)) unavailableUntil.set(key, { until: Date.now() + retryAfterSeconds * 1000, priority });
    }
  }
  modelMeter.record(meterPath, 'unserved', failures[0] ? `${failures[0].id} ${failures[0].why}` : 'no row');
  return null;
}

/** What the ask's answer adds when most recent asks missed their first choice: the storm and why, else nothing. */
export const stormNote = (path = 'local-model') => { const report = modelMeter.report(path); return report.storm ? { fast_path: report } : {}; };

// The share of a chat model's first word that says yes, read from its own probabilities for that word (each spelling
// of yes and of no among its likeliest first words, summed), so a yes-or-no question gets a probability, not a guess.
export function yesShare(choice) {
  const first = choice?.logprobs?.content?.[0];
  const options = first?.top_logprobs?.length ? first.top_logprobs : first ? [first] : [];
  let yes = 0, no = 0;
  for (const option of options) {
    const word = String(option.token ?? '').replace(/[^a-z]/gi, '').toLowerCase();
    const share = Math.exp(Number(option.logprob));
    if (word.startsWith('yes')) yes += share;
    else if (word.startsWith('no')) no += share;
  }
  if (yes + no > 0) return yes / (yes + no);
  const said = String(choice?.message?.content ?? '').trim().toLowerCase();
  return said.startsWith('yes') ? 1 : said.startsWith('no') ? 0 : null;
}

// A classify row whose `ask` is "chat" puts each question to a chat model as one yes-or-no question about the state,
// with the row's own `prompt` words, and answers in the classifier's shape ({ answers: { <name>: { type, noul } } }).
async function askChatYesNo(row, { state, questions }) {
  const answers = {};
  const deadline = Date.now() + row.timeout_seconds * 1000;
  for (const [name, question] of Object.entries(questions)) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) throw new Error(`${row.id} did not answer in time`);
    const means = question.criteria ?? {};
    const reply = await post(row.url, {
      model: row.model, stream: false, temperature: 0, max_tokens: 2, logprobs: true, top_logprobs: 5,
      ...(row.keep_alive ? { keep_alive: row.keep_alive } : {}),
      messages: [{ role: 'system', content: row.prompt }, { role: 'user', content: `${state}\n\n${question.instructions}${means.true ? ` (yes: ${means.true}; no: ${means.false ?? 'not that'})` : ''}` }],
    }, remaining);
    const share = yesShare(reply?.choices?.[0]);
    if (share === null) throw new Error(`${row.id} answered neither yes nor no`);
    answers[name] = { type: question.type ?? 'noul', noul: Math.round(share * 10000) / 10000 };
  }
  return { model: row.model, answers };
}

/** { messages, tools?, max_tokens?, temperature? } -> the chat reply (OpenAI shape, with model), or { state, questions } -> the
 *  classifier's answers; { error } when no model here answered. */
export async function askLocal(input, settings, { priority = 0 } = {}) {
  if (Array.isArray(input.messages)) {
    const job = settings.jobs?.[input.job] ?? settings.jobs?.default ?? {};
    const own = Array.isArray(job.models) ? job.models.map(id => settings.chat.find(row => row.id === id)).filter(Boolean) : settings.chat;
    // After this computer's own servers, the ones the person's other computers offered and they allowed (offered-endpoints.json).
    const rows = typeof settings.offered === 'function' ? [...own, ...(await settings.offered()).rows] : own;
    const failures = [];
    const found = await firstAnswer(rows, row => (input.parts === true ? postStreaming : post)(row.url, {
      model: row.model, messages: input.messages, stream: false, ...(row.keep_alive ? { keep_alive: row.keep_alive } : {}),
      ...(Array.isArray(input.tools) ? { tools: input.tools } : {}),
      ...(job.response_format ? { response_format: job.response_format } : {}),
      max_tokens: Math.min(Number(input.max_tokens) || job.most_tokens || settings.most_tokens, job.most_tokens || settings.most_tokens),
      ...(row.num_ctx ? { options: { num_ctx: row.num_ctx } } : {}),
      ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
      ...(Number.isInteger(input.seed) ? { seed: input.seed } : {}),
    }, job.timeout_seconds ?? row.timeout_seconds), settings.retry_after_seconds, failures, priority);
    return found ? { ...found.reply, model: found.row.model, served_by: found.row.id, ...stormNote() } : { error: settings.words.none, tried: failures };
  }
  if (input.state !== undefined && input.questions && typeof input.questions === 'object') {
    const failures = [];
    // A question for a wired decision goes to the judge measured for it alone (src/decision-evals.json `wired`).
    const judge = settings.wired?.[input.job];
    const judges = judge ? settings.classify.filter(row => row.id === judge) : settings.classify;
    const found = await firstAnswer(judges, row => (row.ask === 'chat' ? askChatYesNo(row, input)
      : post(row.url, { state: input.state, questions: input.questions }, row.timeout_seconds, { 'x-answer-within-seconds': String(row.timeout_seconds) })), settings.retry_after_seconds, failures, priority);
    return found ? { ...found.reply, served_by: found.row.id, ...stormNote() } : { error: settings.words.none, tried: failures };
  }
  return { error: settings.words.needs_input };
}

const run = promisify(execFile);
const gigabytes = bytes => Math.round((bytes / 2 ** 30) * 10) / 10;

/** This Mac: its chip, its memory and the free space in the person's home, in gigabytes. */
export async function thisMac() {
  const [chip, memory, disk] = await Promise.all([
    run('sysctl', ['-n', 'machdep.cpu.brand_string']).then(out => out.stdout.trim(), () => null),
    run('sysctl', ['-n', 'hw.memsize']).then(out => Number(out.stdout.trim()), () => 0),
    statfs(homedir()).then(stats => stats.bavail * stats.bsize, () => 0),
  ]);
  return { chip, memory_gb: gigabytes(memory), free_disk_gb: gigabytes(disk) };
}

/** The models the server has, by name, or null when it is not running. */
async function modelsServed(server) {
  try {
    const answer = await fetch(server.models, { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return null;
    return ((await answer.json()).models ?? []).map(model => model.name);
  } catch { return null; }
}

/** Puts the server on this Mac and waits until it answers. The program comes from the helper owner (computer/helper-runtimes.mjs): a copy the person installed themselves is used as it is, otherwise it is fetched and the receipt says whether it was verified. */
export async function installServer(server, helpers = makeHelperRuntimes()) {
  let got;
  try { got = await helpers.ensure({ id: server.install.helper }); } catch { return null; }
  await run('open', ['-a', got.path]).catch(() => {});
  for (let waited = 0; waited < server.install.wait_seconds; waited += 3) {
    const served = await modelsServed(server);
    if (served) return served;
    await new Promise(done => setTimeout(done, 3000));
  }
  return null;
}

// A name the server keeps with its tag (gemma3:4b) or with `:latest` when the name had none.
const sameModel = (served, model) => served === model || served === `${model}:latest`;

/**
 * The models offered for this Mac and which it has: { mac, server: { running }, models: [{ id, model, job, size_gb,
 * min_memory_gb, fits, have }] }. With `get` ("fitting" for every model that fits and is missing, or a list of offer
 * ids) it gets them too, putting the server on the Mac first when it is missing, and adds `got`: [{ id, done | error }].
 */
export async function modelsForThisMac(input, settings, { helpers } = {}) {
  const mac = await thisMac();
  const { server } = settings;
  let served = await modelsServed(server);
  const asked = input.get === 'fitting' || Array.isArray(input.get);
  if (served === null && asked) served = await installServer(server, helpers);
  const models = settings.offer.map(row => ({
    id: row.id, model: row.model, job: row.job, size_gb: row.size_gb, min_memory_gb: row.min_memory_gb,
    fits: mac.memory_gb >= row.min_memory_gb && mac.free_disk_gb >= row.size_gb + settings.disk_spare_gb,
    have: Boolean(served?.some(name => sameModel(name, row.model))),
  }));
  const answer = { mac, server: { running: served !== null }, models };
  if (!asked) return answer;
  if (served === null) return { ...answer, error: settings.words.no_server };
  const wanted = input.get === 'fitting' ? models.filter(model => model.fits && !model.have).map(model => model.id) : input.get;
  const got = [];
  for (const id of wanted) {
    const model = models.find(row => row.id === id);
    if (!model) { got.push({ id, error: settings.words.not_offered }); continue; }
    if (!model.fits) { got.push({ id, error: settings.words.too_big }); continue; }
    if (model.have) { got.push({ id, done: true }); continue; }
    try {
      const pulled = await post(server.pull, { model: model.model, stream: false }, server.pull_minutes * 60);
      const done = pulled.status === 'success';
      model.have = done;
      got.push(done ? { id, done } : { id, error: String(pulled.error ?? pulled.status) });
    } catch (error) { got.push({ id, error: error.message }); }
  }
  return { ...answer, got };
}

// Policy the person's organisation deployed (computer/managed-settings.mjs): local_models off stops this Mac answering.
async function managedOff() {
  const said = turnedOff(await readManagedSettings(), 'local_models');
  return said ? { error: said } : null;
}

export const localModelTools = {
  async ask(input = {}, context = {}) { return (await managedOff()) ?? askHere(context)(input, { priority: Number.isInteger(context.priority) ? context.priority : 0 }); },
  async fit(input = {}, context = {}) { const off = await managedOff(); if (off) return off; await refreshModelRecords(context); return modelsForThisMac(input, localModelSettings()); },
};
