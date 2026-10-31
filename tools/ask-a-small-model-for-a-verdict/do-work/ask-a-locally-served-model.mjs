// tools/ask-a-small-model-for-a-verdict/do-work/ask-a-locally-served-model.mjs
//
// An adapter for models served on the person's computer through a chat endpoint. These
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
//
// KINDS is the one table of answer kinds this adapter can ask for: how to say the
// shape in words and the JSON schema the answer must fit. A caller with a kind of
// its own adds a row; a row may also carry its own `request` (the body to post)
// and `readReply` (the answer out of the server's reply).
//
// PROTOCOLS is the one table of how a model server is spoken to, named by the
// provider row's `protocol`: where it lists its models, where it chats, whether it
// takes the answer's schema, and where its reply keeps the text.

/** Answer kinds: the words that ask for the shape, and the schema the answer must fit. */
export const KINDS = {
  // A text model has nowhere to put criteria, so what a yes and a no mean
  // gets spelled out in words. Same facts as the classifier receives, in the
  // only form this kind of model can take them.
  'true-or-false': {
    instruction: shape => (shape.means ? `A yes means: ${shape.means.yes}\nA no means: ${shape.means.no}\n\n` : '') +
      'Answer with JSON: {"answer": true} or {"answer": false}. Nothing else.',
    answer: () => ({type: 'boolean'}),
  },
  'one-of': {
    instruction: shape => 'Answer with JSON: {"answer": "<one of the options>"}. Nothing else.\nOptions:\n' +
      shape.options.map(one => (typeof one === 'string' ? `- ${one}` : `- ${one.name}: ${one.description ?? ''}`)).join('\n'),
    answer: shape => ({type: 'string', enum: shape.options.map(one => typeof one === 'string' ? one : one.name)}),
  },
  score: {
    instruction: shape => 'Answer with JSON: {"answer": <number>}. Nothing else.\nScale:\n' +
      shape.levels.map((one, index) => `- ${index}: ${typeof one === 'string' ? one : `${one.name}: ${one.description ?? ''}`}`).join('\n'),
    answer: shape => ({type: 'number', minimum: 0, maximum: shape.levels.length - 1}),
  },
}

/** How each kind of model server is asked. */
export const PROTOCOLS = {
  // Ollama: models with their size, digest and capabilities; chat takes the schema as `format`.
  ollama: {
    inventory: '/api/tags',
    models: served => (served?.models ?? []).map(model => ({name: model.name, size: model.size, digest: model.digest,
      capabilities: model.capabilities})),
    chat: '/api/chat',
    body: ({model, system, content, schema}) => ({model, stream: false, format: schema,
      messages: [{role: 'system', content: system}, {role: 'user', content}]}),
    text: body => body?.message?.content,
  },
  // An OpenAI chat-completions server (mlx_lm.server). It lists every model it could
  // load, so the row names the ones to ask (`models`); it takes no schema, so the
  // shape is asked for in words only, as the kind's instruction already does.
  'openai-chat': {
    needsNamedModels: true,
    inventory: '/v1/models',
    models: served => (served?.data ?? []).map(model => ({name: model.id})),
    chat: '/v1/chat/completions',
    body: ({model, system, content}) => ({model, stream: false, temperature: 0,
      messages: [{role: 'system', content: system}, {role: 'user', content}]}),
    text: body => body?.choices?.[0]?.message?.content,
  },
}

function protocolOf(name) {
  const protocol = PROTOCOLS[name]
  if (!protocol) throw new Error(`unsupported model server protocol: ${name} (${Object.keys(PROTOCOLS).join(', ')})`)
  return protocol
}

function kindOf(shape) {
  const kind = KINDS[shape?.kind]
  if (!kind) throw new Error(`unsupported answer shape: ${shape?.kind}`)
  return kind
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

export function answerSchema(shape) {
  return {type: 'object', properties: {answer: kindOf(shape).answer(shape)}, required: ['answer'], additionalProperties: false}
}

export async function candidates(settings, read = null) {
  // `settings` is the provider row; providersIn has already refused a row with
  // no endpoint or time limit, so neither is assumed here.
  const {endpoint} = settings
  // A local server may first have to load a model many gigabytes large, and
  // the caller asking may be under a deadline of seconds. With no limit, one
  // cold model would hold every question until the caller gave up; the row
  // says how many seconds is too long. The inventory read itself is bounded too.
  const timeoutSeconds = Number(settings.timeout_seconds)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 60)
    throw new Error('local inventory needs a finite timeout greater than zero and at most 60 seconds')
  const protocol = protocolOf(settings.protocol)
  const readJson = read ?? (url => fetch(url, {
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutSeconds * 1000))), redirect: 'error',
  }).then(reply => { if (!reply.ok) throw new Error('inventory unavailable'); return reply.json() }))
  // The reading limit is a fact about the model the person chose, declared on
  // the row; content longer than it is refused, never cut.
  const acceptsCharacters = Number(settings.accepts_characters) > 0 ? {accepts_characters: Number(settings.accepts_characters)} : {}
  const served = protocol.models(await readJson(`${endpoint}${protocol.inventory}`))
  // A server that would load whatever it is asked for is limited to the models the row names.
  if (protocol.needsNamedModels && !(Array.isArray(settings.models) && settings.models.length > 0))
    throw new Error(`a ${settings.protocol} row names the models to ask (models): its server loads any model it is asked for`)
  const named = Array.isArray(settings.models) ? new Set(settings.models) : null
  // Only models that can do what a judge does. An embedding model was offered
  // as a judge, could never answer, and was re-asked on every calibration. What
  // a model can do is what the server says about it, never its name.
  const needs = settings?.needs_capability ?? 'completion'
  return served
    .filter(model => named === null || named.has(model.name))
    // A server that does not describe capabilities keeps every model.
    .filter(model => !Array.isArray(model.capabilities) || model.capabilities.includes(needs))
    // A model too large to stay loaded and answer inside the few seconds a caller may allow
    // can pass calibration and still never answer in time; the row says how
    // large is too large.
    .filter(model => !(Number(settings?.most_bytes) > 0) || (model.size ?? 0) <= Number(settings.most_bytes))
    .slice()
    .sort((left, right) => (left.size ?? 0) - (right.size ?? 0))
    // The digest says which build answers to this name, so a re-pulled model is measured again.
    .map(model => ({name: model.name, size: model.size ?? 0, ...acceptsCharacters,
      ...(model.digest ? {identity: model.digest} : {}), reach: {endpoint, timeoutSeconds, protocol: settings.protocol}}))
}

export async function ask({candidate, question, shape, content, content_parts = []}, post = fetch) {
  // This adapter sends text only. A model that advertises vision does not get
  // addressed inputs or their bytes from here. Never calibrate or judge an
  // incomplete request by silently dropping its required evidence.
  if (!Array.isArray(content_parts) || content_parts.length > 0) {
    throw new Error('local classifier transport does not support supplied content parts')
  }
  const kind = kindOf(shape)
  const {endpoint, timeoutSeconds} = candidate.reach
  const protocol = protocolOf(candidate.reach.protocol)
  const reply = await post(`${endpoint}${protocol.chat}`, {
    method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
    headers: {'content-type': 'application/json'},
    // The schema is asked for where the server takes one, rather than assumed: a
    // model left to its own devices will narrate, and the narration is what breaks the read.
    body: kind.request ? kind.request({content, model: candidate.name, question, shape}) : JSON.stringify(protocol.body({
      model: candidate.name, system: `${question}\n\n${kind.instruction(shape)}`, content, schema: answerSchema(shape),
    })),
  })
  if (kind.readReply) return kind.readReply(reply)
  const body = await reply.json()
  const read = readAnswer(protocol.text(body))
  return read === null ? null : {answer: read.answer, confidence: null, distribution: null}
}
