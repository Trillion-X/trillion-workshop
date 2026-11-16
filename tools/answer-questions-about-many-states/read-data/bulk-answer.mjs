// tools/answer-questions-about-many-states/read-data/bulk-answer.mjs
//
// The two rows' functions, each called by tools/records-door/do-work/run-an-export.mjs as fn(input). Each takes everything
// it works on in its request and returns what it worked out in its answer. Nothing is read from or written to the
// person's records and nothing a run makes lives in a folder: the person's AI reads rows from a store and hands them in,
// and writes the answers wherever it wants them.
//
//   getAClassifierReady({ model })                           the model's weights fetched, checked and named
//   answerManyStates({ model, questions, settings, states }) every state asked every question on this Mac by
//                                                            do-work/answer_many_states.py; the answers come back
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CLASSIFIER_WORKER, startClassifier } from './run-classifier.mjs';

const SETTINGS = ['layout', 'dtype', 'tokens_per_batch', 'max_state_tokens'];
const SNAPSHOT_OUTPUT = fileURLToPath(new URL('../.training-output/snapshot', import.meta.url));

class Refusal extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---- reading the request

function modelOf(input) {
  const model = input?.model;
  if (!isObject(model) || typeof model.classifier !== 'string' || !isObject(model.weights)) {
    throw new Refusal('`model` is the model\'s value: { classifier, weights } (weights: {folder} or {hugging_face: {repo, revision}})');
  }
  return model;
}

function checkRequest(input) {
  const model = modelOf(input);
  if (!isObject(input.questions) || !Object.keys(input.questions).length) throw new Refusal('`questions` is the map {question id: {type: choice|score|noul, instructions, criteria?}}');
  if (!isObject(input.settings)) throw new Refusal(`\`settings\` is an object with ${SETTINGS.join(', ')}`);
  for (const field of SETTINGS) if (!(field in input.settings)) throw new Refusal(`\`settings\` has no \`${field}\``);
  if (!Array.isArray(input.states) || !input.states.length) throw new Refusal('`states` is a list of at least one { id?, state }');
  input.states.forEach((entry, i) => {
    if (!isObject(entry) || !('state' in entry) || (entry.id !== undefined && typeof entry.id !== 'string')) throw new Refusal(`\`states[${i}]\` is { id?: text, state: text or JSON }`);
  });
  return { model, questions: input.questions, settings: input.settings, states: input.states };
}

// ---- the programs this starts

// The worker as a child: standard input the request, standard output its JSON lines. Tests hand in their own `start`.
// -B: Python writes no compiled copy (__pycache__) of imported modules, so a run leaves the tool folder as it was.
export function startWorker(action, request, { python = 'python3', worker = CLASSIFIER_WORKER } = {}) {
  return startClassifier(action, request, { python, worker });
}

const lineOf = text => { try { return JSON.parse(text); } catch { return null; } };

// Watch the child from its start; the returned function waits for its end -> { code, spawnError }.
function watch(child) {
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const ended = new Promise(done => (child.exitCode !== null ? done(child.exitCode) : child.once('close', done)));
  return async () => ({ code: await ended, spawnError });
}

async function lastLine(child) {
  const closed = watch(child);
  let last = null;
  for await (const text of createInterface({ input: child.stdout })) last = lineOf(text) ?? last;
  const { code, spawnError } = await closed();
  if (spawnError) throw spawnError;
  return { last, code };
}

// ---- the rows

export async function getAClassifierReady(input, _context, { start = startWorker } = {}) {
  const model = modelOf(input);
  // The legacy CLI action stays file-free; this Workshop-only action writes into the one declared private tree output.
  const { last } = await lastLine(start('get-ready-with-snapshot', { model, snapshot_output: SNAPSHOT_OUTPUT }));
  if (!last || last.error || !last.result) throw new Refusal(last?.error ?? 'the classifier program printed no answer');
  return { classifier: last.result.classifier, identity: last.result.identity, files: last.result.files, ready: true };
}

export async function answerManyStates(input, _context, { start = startWorker } = {}) {
  const request = checkRequest(input);
  const child = start('work', { model: request.model, questions: request.questions, settings: request.settings, states: request.states.map(s => s.state) });
  const closed = watch(child);
  const answers = [];
  let last = null, checked = false;
  for await (const text of createInterface({ input: child.stdout })) {
    const line = lineOf(text);
    if (!line) continue;
    last = line;
    if (line.checked) checked = true;
    else if (Array.isArray(line.answered)) {
      for (const { state, answers: byQuestion } of line.answered) {
        const id = request.states[state].id;
        answers.push({ index: state, ...(id === undefined ? {} : { id }), answers: byQuestion });
      }
    }
  }
  const { code, spawnError } = await closed();
  if (spawnError) throw spawnError;
  if (!checked) throw new Refusal(last?.error ?? `the classifier program ended (${code}) before it read the request`);
  if (code !== 0 || !last?.result) throw new Refusal(last?.error ?? `the classifier program ended (${code}) without its last line`);
  answers.sort((a, b) => a.index - b.index);
  return {
    status: last.result.status, states_done: last.result.states_done, states: last.result.states,
    classifier_answers_as: last.result.classifier_answers_as, seconds: last.result.seconds, answers,
  };
}
