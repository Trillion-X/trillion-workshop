// packages/ask-a-small-model-for-a-verdict/do-work/ask-a-locally-served-model.mjs
//
// An adapter for models served on this machine through a chat endpoint. These
// generate text, so the shape has to be asked for in words and then read back
// out of whatever they wrote, and they may wrap it in chatter.
//
// Confidence is null here, and that is the honest answer rather than a gap.
// A model that writes "true" has not told you how sure it is, and asking it to
// also write a number gets a number it made up, which is worse than nothing
// because it looks like a measurement. Only a classifier that returns a
// probability distribution can fill that field.
//
// Candidates come back smallest first, so the cheapest thing that can actually
// pass the calibration is the thing that answers.

const ENDPOINT = process.env.LOCAL_MODEL_ENDPOINT || 'http://127.0.0.1:11434'

/** What to ask for, in words, so the answer comes back in the declared shape. */
function askingFor(question, shape) {
  const kinds = {
    // A text model has nowhere to put criteria, so what a yes and a no mean
    // gets spelled out in words. Same facts as the classifier receives, in the
    // only form this kind of model can take them.
    'true-or-false': () =>
      (shape.means ? `A yes means: ${shape.means.yes}\nA no means: ${shape.means.no}\n\n` : '') +
      'Answer with JSON: {"answer": true} or {"answer": false}. Nothing else.',
    'one-of': () =>
      'Answer with JSON: {"answer": "<one of the options>"}. Nothing else.\nOptions:\n' +
      shape.options
        .map(one => (typeof one === 'string' ? `- ${one}` : `- ${one.name}: ${one.description ?? ''}`))
        .join('\n'),
    score: () =>
      'Answer with JSON: {"answer": <number>}. Nothing else.\nScale:\n' +
      shape.levels
        .map((one, index) => `- ${index}: ${typeof one === 'string' ? one : `${one.name}: ${one.description ?? ''}`}`)
        .join('\n'),
  }
  return `${question}\n\n${kinds[shape.kind]()}`
}

/** The first JSON object in a reply, since these models like to say hello first. */
export function readAnswer(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function answerSchema(shape) {
  const answer = shape.kind === 'true-or-false'
    ? {type: 'boolean'}
    : shape.kind === 'one-of'
      ? {type: 'string', enum: shape.options.map(one => typeof one === 'string' ? one : one.name)}
      : shape.kind === 'score'
        ? {type: 'number', minimum: 0, maximum: shape.levels.length - 1}
        : null
  if (!answer) throw new Error(`unsupported answer shape: ${shape.kind}`)
  return {type: 'object', properties: {answer}, required: ['answer'], additionalProperties: false}
}

export async function candidates(settings = {}, fetchJson = url => fetch(url).then(reply => reply.json())) {
  // The turn judge passes the provider DATA row to every adapter. Earlier this
  // argument was a test-only fetch function, so a real DATA row was called as
  // a function and Ollama silently offered no candidates.
  const read = typeof settings === 'function' ? settings : fetchJson
  const endpoint = typeof settings?.endpoint === 'string' ? settings.endpoint : ENDPOINT
  // A local server may first have to load a model many gigabytes large, and
  // the judge that asks runs inside a hook with a deadline of seconds. With no
  // limit, one cold model held every Codex tool call until the hook was killed.
  const timeoutSeconds = Number(settings?.timeout_seconds ?? 3)
  const served = await read(`${endpoint}/api/tags`)
  // Only models that can do what a judge does. An embedding model was offered
  // as a judge, could never answer, and was re-asked on every calibration. What
  // a model can do is what the server says about it, never its name.
  const needs = settings?.needs_capability ?? 'completion'
  return (served?.models ?? [])
    // A server that does not describe capabilities keeps every model, as before.
    .filter(model => !Array.isArray(model.capabilities) || model.capabilities.includes(needs))
    // A model too large to stay loaded and answer inside a turn's few seconds
    // can pass calibration and still never answer a turn; the row says how
    // large is too large.
    .filter(model => !(Number(settings?.most_bytes) > 0) || (model.size ?? 0) <= Number(settings.most_bytes))
    .slice()
    .sort((left, right) => (left.size ?? 0) - (right.size ?? 0))
    .map(model => ({name: model.name, size: model.size ?? 0, reach: {endpoint, timeoutSeconds}}))
}

export async function ask({candidate, question, shape, content}, post = fetch) {
  const timeoutSeconds = candidate?.reach?.timeoutSeconds
  const reply = await post(`${candidate?.reach?.endpoint ?? ENDPOINT}/api/chat`, {
    method: 'POST',
    ...(timeoutSeconds > 0 ? {signal: AbortSignal.timeout(timeoutSeconds * 1000)} : {}),
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model: candidate.name,
      stream: false,
      // Asked for rather than assumed: a model left to its own devices will
      // narrate, and the narration is what breaks the read.
      format: answerSchema(shape),
      messages: [
        {role: 'system', content: askingFor(question, shape)},
        {role: 'user', content},
      ],
    }),
  })
  const body = await reply.json()
  const read = readAnswer(body?.message?.content)
  return read === null ? null : {answer: read.answer, confidence: null, distribution: null}
}
