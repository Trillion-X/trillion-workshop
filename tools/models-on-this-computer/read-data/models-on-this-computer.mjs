// tools/models-on-this-computer/read-data/models-on-this-computer.mjs
//
// Purpose
//   Answers a model call with a model served on the person's own computer, so work that needs a model (checking
//   answers, telling chatter from requests, turning words into vectors that compare meaning) costs nobody anything (`ask`,
//   tool:ask-a-model), and says which free models
//   fit this computer and gets them onto its model server (`fit`, tool:get-free-models). Runs as a `computer` row
//   through tools/workflows/do-work/run-a-function.mjs. Moved from old trillion computer/local-models.mjs.
//
// Non-negotiable invariants
//   1. Which servers and models answer is DATA (read-data/models-on-this-computer.json); this file names none. A server is
//      named by its local door, never by a port: the port is the one this computer's report names under that door
//      (`placed`), so a row whose door the computer does not report is never asked.
//   2. Only this computer's own servers are asked; the words never leave it except as the answer.
//   3. A server that is not running is skipped; when none answers the tool says so in words (error), and names for each
//      model why it did not answer (`tried`). A model resting after a failure is passed over without being asked; when a
//      row passed over was resting, the answer is `retryable` with `retry_at`, the earliest time a resting row comes back. A model that refused only this request's shape (400-499, such as a model
//      that takes no tool calls) is passed over for that request and not rested, so one request it cannot take never
//      silences the asks it can.
//   4. A job that says `choose` asks the shared chooser (tools/choose-an-answerer) first: the answerer rows (DATA
//      `answerers.rows`) are weighed against each provider's limits read fresh through its own door, the models that door
//      lists live, and this process's rests (a 429 or a failure rests a row, which the chooser reads as a cool-down). A
//      pick is asked first; no pick (limits at the threshold, a cool-down, no reading) leaves the job's own models.
//   5. `fit` (modelsForThisMac) reads this computer (its chip, memory and free space) and the models its server has,
//      and offers only models that fit (DATA `offer`); asked to get them, it has the server download each.
//
// Usage
//   node /opt/workflows/do-work/run-a-function.mjs /opt/models-on-this-computer/read-data/models-on-this-computer.mjs ask|fit
//
import { cpus, homedir, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { chooseAnswerer } from '../../choose-an-answerer/read-data/choose-an-answerer.mjs';
import { modelsOf } from '../../choose-an-answerer/read-data/load-choices.mjs';
import { readCodexLimits } from '../../codex-usage-read/read-data/codex-limits.mjs';

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
const refusedTheAsk = error => Boolean(error?.said) || (error?.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
const whyNot = error => (error?.said ?? (error?.status ? `answered ${error.status}` : error?.name === 'TimeoutError' ? 'did not answer in time' : 'is not running'));

// The fields a job's row says its answer must have (`answer_has`) that this reply lacks: its content is read as one JSON
// object, and each named field must be words. A reply lacking any is that model's failure, so the next model is asked;
// the model is not rested for it, since it answered.
export function answerLacks(reply, fields) {
  if (!Array.isArray(fields) || !fields.length) return [];
  let value;
  try { value = JSON.parse(String(reply?.choices?.[0]?.message?.content ?? '')); } catch { return fields; }
  return fields.filter(field => typeof value?.[field] !== 'string' || !value[field].trim());
}

/**
 * What a call says when no row answered: the words and each row's reason, and, when some row passed over was only
 * resting, `retryable: true` with `retry_at` (the earliest time one comes back, ISO). When every row passed over was
 * resting, the words say so and when, so a caller (the engine's step retry) waits until `retry_at` and asks again instead
 * of treating the step as failed.
 */
export function noAnswer(settings, failures, extra = {}) {
  const rests = failures.map(failure => failure.resting_until).filter(Boolean).sort();
  if (!rests.length) return { error: settings.words.none, tried: failures, ...extra };
  const allResting = failures.every(failure => failure.resting_until);
  const words = allResting ? String(settings.words.resting ?? settings.words.none).replaceAll('{until}', rests[0]) : settings.words.none;
  return { error: words, tried: failures, retryable: true, retry_at: rests[0], ...extra };
}

/** Asks the first row of `rows` whose server answers; null when none does. `failures` (an array) is filled with each
 *  row passed over and why, so an empty result can say what happened. */
export async function firstAnswer(rows, ask, retryAfterSeconds = 0, failures = [], priority = 0) {
  for (const row of rows) {
    if (row.not_reported) { failures.push({ id: row.id, why: row.not_reported }); continue; }
    const key = modelKey(row);
    const resting = unavailableUntil.get(key);
    if (resting && resting.until > Date.now() && priority <= resting.priority) { failures.push({ id: row.id, why: 'is resting after a failure', resting_until: new Date(resting.until).toISOString() }); continue; }
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

// A chat row names its wire shape (DATA `api_shape`). `chat` is the OpenAI chat-completions shape the local servers speak;
// `responses` is the OpenAI Responses shape a codex-lb door serves (`/v1/responses`): the system words go to
// `instructions`, the rest to `input`, and the answer comes back in the chat shape, so every caller reads both alike. A
// row written before the field existed is `chat`. Words a shape does not take (tools, streamed parts) are refused for
// that request only, as a model that takes no such request; response_format, seed, temperature and num_ctx are not sent
// in the responses shape, and a job whose answer must be structured is checked by `answer_has`.
const shapes = new Set(['chat', 'responses']);

/** The OpenAI Responses reply in the chat shape: its message text, its stop reason and its token counts. */
export function chatReplyOf(reply, model) {
  const text = (reply?.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text').map(part => part.text).join('');
  const usage = reply?.usage ? { prompt_tokens: reply.usage.input_tokens, completion_tokens: reply.usage.output_tokens, total_tokens: reply.usage.total_tokens } : undefined;
  return { model: reply?.model ?? model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: reply?.status === 'completed' ? 'stop' : 'length' }], ...(usage ? { usage } : {}) };
}

/** One chat request to a row, in the row's own wire shape; the answer is always returned in the chat shape. */
async function askChatShape(row, body, seconds, streamed) {
  const shape = row.api_shape ?? 'chat';
  if (!shapes.has(shape)) throw Object.assign(new Error(`${row.id} has no known api_shape`), { said: `has no known wire shape (${shape})` });
  if (shape === 'chat') return (streamed ? postStreaming : post)(row.url, body, seconds);
  if (streamed) throw Object.assign(new Error(`${row.id} streams no parts`), { said: 'streams no parts in this shape' });
  if (Array.isArray(body.tools)) throw Object.assign(new Error(`${row.id} takes no tool calls`), { said: 'takes no tool calls in this shape' });
  const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const reply = await post(row.url, {
    model: body.model, store: false, stream: false,
    ...(system ? { instructions: system } : {}),
    input: body.messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, content: message.content })),
    ...(body.max_tokens ? { max_output_tokens: body.max_tokens } : {}),
  }, seconds);
  return chatReplyOf(reply, body.model);
}

// How each provider's limits are read, by the reader a limits row names (DATA `answerers.limits.<provider>.reader`).
const LIMIT_READERS = { 'codex-lb-accounts': readCodexLimits };

/**
 * The chat row the shared chooser picks for a job that says `choose`, with the model it picked, and why; `{ row: null,
 * why }` when nothing fits (the job's own models answer then). Limits and models are read through the doors the
 * answerer limits rows name (placed: their `url`); a door this computer does not report gives no reading, which the
 * chooser skips. A row resting in this process after a failure or a 429 is a cool-down for every account of its provider.
 */
export async function chosenRow(job, settings, { now = new Date(), readers = LIMIT_READERS, fetchImpl = fetch } = {}) {
  const answerers = settings.answerers;
  if (!job?.choose || !Array.isArray(answerers?.rows) || !answerers.rows.length) return { row: null, why: null };
  const limits = [], models = {}, cooldowns = [];
  for (const [provider, source] of Object.entries(answerers.limits ?? {})) {
    if (!source?.url) continue;
    const read = readers[source.reader];
    if (read) limits.push(...await read(source.url, { now, fetchImpl }).catch(() => []));
    models[provider] = await modelsOf(source.url, { fetchImpl });
  }
  const chatOf = answerer => (settings.chat ?? []).find(item => item.id === answerer.chat);
  for (const answerer of answerers.rows) {
    const chat = chatOf(answerer);
    if (!chat) continue;
    const rests = (answerer.models ?? []).map(model => unavailableUntil.get(modelKey({ ...chat, model }))).filter(rest => rest && rest.until > now.getTime());
    const until = Math.max(0, ...rests.map(rest => rest.until));
    if (until) for (const account of answerer.account_pool ?? []) cooldowns.push({ provider: answerer.provider, account, until: new Date(until).toISOString() });
  }
  const pick = chooseAnswerer({ kind: job.choose.kind, fit: job.choose.fit ?? [] }, { providers: answerers.rows, limits, models, cooldowns, now, threshold_percent: answerers.threshold_percent });
  if (pick.none) return { row: null, why: pick.none };
  const answerer = answerers.rows.find(row => row.provider === pick.provider && (row.models ?? []).includes(pick.model) && chatOf(row));
  return answerer ? { row: { ...chatOf(answerer), model: pick.model }, why: pick.why } : { row: null, why: `${pick.provider} names no chat row` };
}

/** { messages, tools?, max_tokens?, temperature? } -> the chat reply (OpenAI shape, with model), { state, questions } -> the
 *  classifier's answers, or { texts } -> one vector per text ({ vectors, model, dimensions }); { error } when no model here
 *  answered. */
export async function askLocal(input, settings, { priority = 0 } = {}) {
  if (Array.isArray(input.messages)) {
    const job = settings.jobs?.[input.job] ?? settings.jobs?.default ?? {};
    const checked = reply => {
      const lacking = answerLacks(reply, job.answer_has);
      if (lacking.length) throw Object.assign(new Error('the answer lacks fields'), { said: `answered without ${lacking.join(', ')}` });
      return reply;
    };
    const listed = Array.isArray(job.models) ? job.models.map(id => settings.chat.find(row => row.id === id)).filter(Boolean) : settings.chat;
    const picked = await chosenRow(job, settings);
    const rows = picked.row ? [picked.row, ...listed.filter(row => row.id !== picked.row.id)] : listed;
    const failures = [];
    const found = await firstAnswer(rows, async row => checked(await askChatShape(row, {
      model: row.model, messages: input.messages, stream: false, ...(row.keep_alive ? { keep_alive: row.keep_alive } : {}),
      ...(row.reasoning_effort ? { reasoning_effort: row.reasoning_effort } : {}),
      ...(Array.isArray(input.tools) ? { tools: input.tools } : {}),
      ...(job.response_format ? { response_format: job.response_format } : {}),
      max_tokens: Math.min(Number(input.max_tokens) || job.most_tokens || settings.most_tokens, job.most_tokens || settings.most_tokens),
      ...(row.num_ctx ? { options: { num_ctx: row.num_ctx } } : {}),
      ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
      ...(Number.isInteger(input.seed) ? { seed: input.seed } : {}),
    }, job.timeout_seconds ?? row.timeout_seconds, input.parts === true)), settings.retry_after_seconds, failures, priority);
    const because = picked.why ? { chosen_because: picked.why } : {};
    return found ? { ...found.reply, model: found.row.model, served_by: found.row.id, ...because } : noAnswer(settings, failures, because);
  }
  if (input.state !== undefined && input.questions && typeof input.questions === 'object') {
    const failures = [];
    // A question for a wired decision goes to the judge measured for it alone (DATA `wired`).
    const judge = settings.wired?.[input.job];
    const judges = judge ? settings.classify.filter(row => row.id === judge) : settings.classify;
    const found = await firstAnswer(judges, row => (row.ask === 'chat' ? askChatYesNo(row, input)
      : post(row.url, { state: input.state, questions: input.questions }, row.timeout_seconds, { 'x-answer-within-seconds': String(row.timeout_seconds) })), settings.retry_after_seconds, failures, priority);
    return found ? { ...found.reply, served_by: found.row.id } : noAnswer(settings, failures);
  }
  if (Array.isArray(input.texts)) {
    if (!input.texts.length || !input.texts.every(text => typeof text === 'string')) return { error: settings.words.needs_input };
    // Vectors are comparable only with vectors from the same model, so a job names the embedding rows it may use (DATA
    // `jobs`, `meaning` when the input names none) and the answer names the model that made them.
    const job = settings.jobs?.[input.job] ?? settings.jobs?.meaning ?? {};
    const rows = Array.isArray(job.models) ? job.models.map(id => (settings.embed ?? []).find(row => row.id === id)).filter(Boolean) : (settings.embed ?? []);
    const failures = [];
    const found = await firstAnswer(rows, async row => {
      const reply = await post(row.url, { model: row.model, input: input.texts, ...(row.keep_alive ? { keep_alive: row.keep_alive } : {}) }, job.timeout_seconds ?? row.timeout_seconds);
      if (!Array.isArray(reply?.embeddings) || reply.embeddings.length !== input.texts.length) throw Object.assign(new Error('no vectors'), { said: 'answered without one vector for each text' });
      return reply;
    }, settings.retry_after_seconds, failures, priority);
    return found ? { vectors: found.reply.embeddings, model: found.row.model, dimensions: found.reply.embeddings[0].length, served_by: found.row.id }
      : noAnswer(settings, failures);
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
  if (!server?.models) return null;
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

/**
 * The settings with each row's address made from this computer's reported ports (`local_ports`, door name -> port): a
 * row whose door is not reported gets no address and the `not_reported` words, and is passed over with them as its
 * reason (`tried`), like a server that is not running; no port is ever guessed.
 */
export function placed(settings, ports = {}) {
  const port = door => { const number = ports?.[door]; return Number.isInteger(number) && number >= 1024 && number <= 65535 ? number : null; };
  const at = (door, path) => port(door) === null ? null : `http://127.0.0.1:${port(door)}${path}`;
  const row = item => {
    if (!item || typeof item.door !== 'string') return item;
    const url = at(item.door, item.path ?? '');
    return { ...item, url, ...(url ? {} : { not_reported: String(settings.words?.not_reported ?? '').replaceAll('{door}', item.door) }) };
  };
  const server = settings.server?.door ? { ...settings.server, models: at(settings.server.door, settings.server.models), pull: at(settings.server.door, settings.server.pull) } : settings.server;
  const answerers = settings.answerers ? { ...settings.answerers, limits: Object.fromEntries(Object.entries(settings.answerers.limits ?? {})
    .map(([provider, source]) => [provider, { ...source, url: at(source.door, source.path ?? '') }])) } : settings.answerers;
  return { ...settings, server, chat: (settings.chat ?? []).map(row), classify: (settings.classify ?? []).map(row), embed: (settings.embed ?? []).map(row), ...(answerers ? { answerers } : {}) };
}

/** What a row hands in: { input, local_ports } (tool-rows.json stdin); a call with no ports reaches no server. */
const given = (handed = {}) => handed && typeof handed === 'object' && 'local_ports' in handed
  ? { input: handed.input ?? {}, ports: handed.local_ports ?? {} } : { input: handed ?? {}, ports: {} };

/** tool:ask-a-model */
export const ask = (handed = {}) => { const { input, ports } = given(handed); return askLocal(input, placed(localModelSettings(), ports)); };

/** tool:get-free-models */
export const fit = (handed = {}) => { const { input, ports } = given(handed); return modelsForThisMac(input, placed(localModelSettings(), ports)); };
