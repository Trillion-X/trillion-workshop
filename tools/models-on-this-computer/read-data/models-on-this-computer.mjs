// tools/models-on-this-computer/read-data/models-on-this-computer.mjs
//
// Purpose
//   Answers a model call with a model served on the person's own computer, so work that needs a model (checking
//   answers, telling chatter from requests) costs nobody anything (`ask`, tool:ask-a-model), and says which free models
//   fit this computer and gets them onto its model server (`fit`, tool:get-free-models). Runs as a `computer` row
//   through tools/records-door/do-work/run-an-export.mjs. Moved from old trillion computer/local-models.mjs.
//
// Non-negotiable invariants
//   1. Which servers and models answer is DATA (read-data/models-on-this-computer.json); this file names none.
//   2. Only this computer's own servers are asked; the words never leave it except as the answer.
//   3. A server that is not running is skipped; when none answers the tool says so in words (error), and names for each
//      model why it did not answer (`tried`). A model that refused only this request's shape (400-499, such as a model
//      that takes no tool calls) is passed over for that request and not rested, so one request it cannot take never
//      silences the asks it can.
//   4. `fit` (modelsForThisMac) reads this computer (its chip, memory and free space) and the models its server has,
//      and offers only models that fit (DATA `offer`); asked to get them, it has the server download each.
//
// Usage
//   node /opt/records-door/do-work/run-an-export.mjs /opt/models-on-this-computer/read-data/models-on-this-computer.mjs ask|fit
//
import { cpus, homedir, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

/** The settings file: the model tables (chat, jobs, classify, offer, wired), the server, the limits and the words. */
export const localModelSettings = () => JSON.parse(readFileSync(new URL('./models-on-this-computer.json', import.meta.url), 'utf8'));

async function post(url, body, seconds, headers = {}) {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(seconds * 1000) });
  if (!answer.ok) throw Object.assign(new Error(`${url} answered ${answer.status}`), { status: answer.status });
  return answer.json();
}

// The chat asked with stream: true: each server-sent chunk is appended to the keyed text part `answer` (the `text`
// merge of old trillion src/keyed-parts.json) so the answer is built part by part; the reply keeps the OpenAI shape and
// also carries the parts it was built from.
async function postStreaming(url, body, seconds, headers = {}) {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(seconds * 1000) });
  if (!answer.ok) throw Object.assign(new Error(`${url} answered ${answer.status}`), { status: answer.status });
  const entry = { seq: 0, order: [], parts: {} };
  let pending = '', model = null;
  const take = line => {
    const text = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!text || text === '[DONE]') return;
    const chunk = JSON.parse(text);
    model = chunk.model ?? model;
    const piece = chunk.choices?.[0]?.delta?.content;
    if (!piece) return;
    if (!('answer' in entry.parts)) entry.order.push('answer');
    entry.parts.answer = { type: 'text', text: `${entry.parts.answer?.text ?? ''}${piece}` };
    entry.seq += 1;
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

// A busy or stopped model is tried again after a short pause, instead of making every waiting ask spend its full
// timeout on the same failure. The key is the local endpoint and model, so chat and classification share its state.
// A rest silences only asks no more important than the ask that caused it. The rests live as long as the process: a
// run on the engine is one process, so they hold within one run.
const unavailableUntil = new Map();
const modelKey = row => `${row.url}\0${row.model ?? row.id}`;

// A server that refused this request's shape (400-499: the model takes no tool calls, the input is too long) is working;
// resting it would silence its other asks for the pause. Only silence, a failing server or a full queue rests a model.
const refusedTheAsk = error => error?.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
const whyNot = error => (error?.status ? `answered ${error.status}` : error?.name === 'TimeoutError' ? 'did not answer in time' : 'is not running');

/** Asks the first row of `rows` whose server answers; null when none does. `failures` (an array) is filled with each
 *  row passed over and why, so an empty result can say what happened. */
export async function firstAnswer(rows, ask, retryAfterSeconds = 0, failures = [], priority = 0) {
  for (const row of rows) {
    const key = modelKey(row);
    const resting = unavailableUntil.get(key);
    if (resting && resting.until > Date.now() && priority <= resting.priority) { failures.push({ id: row.id, why: 'is resting after a failure' }); continue; }
    try {
      const reply = await ask(row);
      unavailableUntil.delete(key);
      return { row, reply };
    } catch (error) {
      failures.push({ id: row.id, why: whyNot(error) });
      if (retryAfterSeconds > 0 && !refusedTheAsk(error)) unavailableUntil.set(key, { until: Date.now() + retryAfterSeconds * 1000, priority });
    }
  }
  return null;
}

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
    const rows = Array.isArray(job.models) ? job.models.map(id => settings.chat.find(row => row.id === id)).filter(Boolean) : settings.chat;
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
    return found ? { ...found.reply, model: found.row.model, served_by: found.row.id } : { error: settings.words.none, tried: failures };
  }
  if (input.state !== undefined && input.questions && typeof input.questions === 'object') {
    const failures = [];
    // A question for a wired decision goes to the judge measured for it alone (DATA `wired`).
    const judge = settings.wired?.[input.job];
    const judges = judge ? settings.classify.filter(row => row.id === judge) : settings.classify;
    const found = await firstAnswer(judges, row => (row.ask === 'chat' ? askChatYesNo(row, input)
      : post(row.url, { state: input.state, questions: input.questions }, row.timeout_seconds, { 'x-answer-within-seconds': String(row.timeout_seconds) })), settings.retry_after_seconds, failures, priority);
    return found ? { ...found.reply, served_by: found.row.id } : { error: settings.words.none, tried: failures };
  }
  return { error: settings.words.needs_input };
}

const gigabytes = bytes => Math.round((bytes / 2 ** 30) * 10) / 10;

/** This computer: its chip, its memory and the free space where the run's home is, in gigabytes. Chip and memory are
 *  the system's own sysctl values (machdep.cpu.brand_string, hw.memsize), read in process: the sandbox allows reading
 *  them but not starting /usr/sbin/sysctl. */
export async function thisMac() {
  const disk = await statfs(homedir()).then(stats => stats.bavail * stats.bsize, () => 0);
  return { chip: cpus()[0]?.model?.trim() || null, memory_gb: gigabytes(totalmem()), free_disk_gb: gigabytes(disk) };
}

/** The models the server has, by name, or null when it is not running. */
async function modelsServed(server) {
  try {
    const answer = await fetch(server.models, { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return null;
    return ((await answer.json()).models ?? []).map(model => model.name);
  } catch { return null; }
}

// A name the server keeps with its tag (gemma3:4b) or with `:latest` when the name had none.
const sameModel = (served, model) => served === model || served === `${model}:latest`;

/**
 * The models offered for this computer and which it has: { mac, server: { running }, models: [{ id, model, job, size_gb,
 * min_memory_gb, fits, have }] }. With `get` ("fitting" for every model that fits and is missing, or a list of offer
 * ids) it gets them too, through the running server, and adds `got`: [{ id, done | error }].
 */
export async function modelsForThisMac(input, settings) {
  const mac = await thisMac();
  const { server } = settings;
  const served = await modelsServed(server);
  const asked = input.get === 'fitting' || Array.isArray(input.get);
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

/** tool:ask-a-model */
export const ask = (input = {}) => askLocal(input, localModelSettings());

/** tool:get-free-models */
export const fit = (input = {}) => modelsForThisMac(input, localModelSettings());
