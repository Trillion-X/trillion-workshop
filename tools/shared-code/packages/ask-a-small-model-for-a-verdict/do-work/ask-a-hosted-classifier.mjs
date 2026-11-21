import {readFileSync} from 'node:fs'

// packages/ask-a-small-model-for-a-verdict/do-work/ask-a-hosted-classifier.mjs
//
// An adapter for a hosted classifier: something that does not write text at
// all, and answers only by returning probabilities across options it was
// handed. That is a different thing from a small chat model, and the
// difference is the whole reason this adapter exists.
//
//   - It cannot invent an option, so its mistakes are bounded by the list.
//   - It returns the spread, not just the winner, so confidence is measured
//     rather than claimed.
//   - It reads a bounded amount, and oversized content is refused upstream
//     rather than trimmed.
//
// The wire format below was read from the service's own published API
// reference rather than guessed. The three primitives and their exact request
// and answer shapes:
//
//   noul    a yes/no question. criteria is optional and says what a yes and a
//           no mean. The answer is ONE NUMBER, the probability of yes, and it
//           carries no separate confidence, because for a yes/no question the
//           probability already is the confidence.
//   choice  one option from a map of option to description, at most 255. The
//           answer carries the winning option, the full distribution, and a
//           confidence derived from how concentrated that distribution is.
//   score   an ordered array of level descriptions, at least 2 and at most 10.
//           The answer is a probability-weighted number that can land BETWEEN
//           levels, so 1.05 is a real answer and not a rounding error.
//
// Confidence here means the distribution is concentrated, which is not the
// same as the workflow being correct and is never permission to act. That
// judgement belongs to the bands the rubric declares.

// Read when asked rather than when loaded, so where to reach a classifier can
// come from DATA a caller supplies. A hosted service and one running on this
// machine differ by a URL and nothing else, which is the entire reason the
// same adapter serves both: the local runtime deliberately speaks this shape.
const endpoint = () => process.env.CLASSIFIER_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
const key = () => process.env.CLASSIFIER_API_KEY || null
const model = () => process.env.CLASSIFIER_MODEL || 'jev-latest'

/**
 * Ask the vault for a secret by the name DATA gave, and keep it in memory only.
 * This is the road that matters: DATA says WHICH credential, the vault holds
 * the value, and nothing on the way writes it down.
 */
export async function useVaultSecret(secretName) {
  if (!secretName) return false
  try {
    const {heldByTheVault} = await import('../../../../connect-a-service-and-seal-its-key/read-data/ask-the-vault-for-one-secret.mjs')
    const held = await heldByTheVault(secretName)
    const value = typeof held === 'string' ? held : held?.api_key ?? held?.value ?? null
    if (!value) return false
    process.env.CLASSIFIER_API_KEY = String(value).trim()
    return true
  } catch {
    // The vault not answering is not a credential being absent, and the two
    // must never be reported the same way. The caller simply gets no candidate.
    return false
  }
}

/** Point the adapter at a classifier. Settings are DATA, never a branch. */
export function configure(settings = {}) {
  if (settings.endpoint) process.env.CLASSIFIER_ENDPOINT = settings.endpoint
  if (settings.model) process.env.CLASSIFIER_MODEL = settings.model
  if (settings.key) process.env.CLASSIFIER_API_KEY = settings.key
  // A path to read the credential from, never the credential itself. Kept for
  // the narrow case of a credential that has not reached the vault yet.
  if (settings.key_file) {
    try {
      process.env.CLASSIFIER_API_KEY = readFileSync(settings.key_file, 'utf8').trim()
    } catch {
      // An unreadable credential path is simply no credential, and candidates()
      // will offer nothing rather than sending an empty Authorization header.
    }
  }
  // Something reachable on this machine needs no credential, and demanding one
  // anyway would be a ceremony that blocks the only free road.
  if (settings.needs_no_key) process.env.CLASSIFIER_API_KEY = 'not-needed'
}

// Limits the service enforces. Refusing here, with the number, beats a 422 that
// names a field and not the reason.
const MOST_OPTIONS = 255
const MOST_LEVELS = 10

/**
 * One candidate, because a hosted classifier is a single service rather than a
 * list of served models. It still goes through calibration exactly like any
 * other candidate. Being fast and cheap is not evidence of being right on this
 * particular question, and the cases are the only thing that settles that.
 *
 * `accepts_characters` is the declared reading limit, kept deliberately under
 * the true ceiling, because the failure at the boundary is a confident answer
 * about a fragment.
 */
export async function candidates(settings = {}) {
  // A named secret is resolved from the vault at ask time, never held in DATA.
  if (settings.secret_name) await useVaultSecret(settings.secret_name)
  const credential = settings.needs_no_key ? 'not-needed' : key()
  if (!credential) return []
  // Every candidate carries WHERE IT LIVES. Settings used to sit in module
  // state, which meant two providers using this one adapter overwrote each
  // other: configuring the second silently redirected the first, and a
  // scoreboard then reported two separate classifiers with identical scores
  // because both calls had gone to the same place. Identical scores from
  // different models is the tell, and it is easy to read as agreement.
  return [
    {
      name: settings.model || model(),
      size: 0,
      accepts_characters: 110000,
      reach: {
        endpoint: settings.endpoint || endpoint(),
        model: settings.model || model(),
        credential,
        // How long one request may take, and how many samples one question
        // gets, are the provider row's DATA. A model that answers the same
        // thing every time gains nothing from a second sample but its cost.
        ...(Number(settings.timeout_seconds) > 0 ? {timeoutSeconds: Number(settings.timeout_seconds)} : {}),
        ...(Number(settings.samples) > 0 ? {samples: Number(settings.samples)} : {}),
      },
    },
  ]
}

const describe = one => (typeof one === 'string' ? {name: one, description: null} : one)

/**
 * Several questions about the SAME content, in one request.
 *
 * This is the property worth having and it is easy to miss: the service takes
 * one state and a MAP of questions, answers them in a single pass, and they
 * cannot see one another's answers. So asking six things about one turn costs
 * one round trip rather than six, and the six are genuinely independent, which
 * is what makes them safe to ask together.
 *
 * Questions about DIFFERENT content cannot batch, because a request carries
 * exactly one state. That is why calibration still goes one case at a time.
 */
export function intoBatchRequest({content, asking}) {
  const questions = {}
  for (const [id, one] of Object.entries(asking)) {
    const {questions: single} = intoRequest({question: one.question, shape: one.shape, content})
    questions[id] = single.verdict
  }
  return {state: content, model: model(), questions}
}

/** Our question, in the shape the service expects. */
export function intoRequest({question, shape, content}) {
  const asQuestion = {
    // A yes/no question wants a SHORT instruction plus separate criteria
    // saying what a yes and a no mean. Folding that guidance into the
    // instruction instead, the way one would prompt a chat model, measurably
    // wrecks the answers: the same model that got a short question right
    // scored 2 out of 8 on a discursive one carrying its own answer key.
    'true-or-false': () => ({
      type: 'noul',
      instructions: question,
      ...(shape.means ? {criteria: {true: shape.means.yes, false: shape.means.no}} : {}),
    }),
    'one-of': () => {
      const options = shape.options.map(describe)
      if (options.length > MOST_OPTIONS) {
        throw new Error(`a choice takes at most ${MOST_OPTIONS} options and this one has ${options.length}`)
      }
      return {
        type: 'choice',
        instructions: question,
        // A map of option to its rubric description, null when the name says
        // enough on its own.
        criteria: Object.fromEntries(options.map(one => [one.name, one.description ?? null])),
      }
    },
    score: () => {
      const levels = shape.levels.map(describe)
      if (levels.length > MOST_LEVELS) {
        throw new Error(`a score takes at most ${MOST_LEVELS} levels and this one has ${levels.length}`)
      }
      return {
        type: 'score',
        instructions: question,
        // An ordered array: position in the array is the score.
        criteria: levels.map(one => (one.description ? `${one.name}: ${one.description}` : one.name)),
      }
    },
  }
  // Questions are a map keyed by ids we choose. The id is for our code and is
  // never sent to the model, so the instructions must carry the whole meaning.
  return {state: content, model: model(), questions: {verdict: asQuestion[shape.kind]()}}
}

/** Their answer, in the shape this package reads. */
export function outOfReply(body, shape) {
  const answered = body?.answers?.verdict ?? null
  if (!answered) return null

  const spread = probabilities =>
    probabilities && typeof probabilities === 'object'
      ? Object.entries(probabilities).map(([option, probability]) => ({option, probability}))
      : null

  if (shape.kind === 'true-or-false') {
    const yes = answered.noul
    if (typeof yes !== 'number') return null
    // 0.9 is a confident yes and 0.1 is an equally confident no. Reading the
    // raw number as a confidence would make every confident NO look unsure,
    // which turns a calibrated model back into a coin flip.
    //
    // Confidence is computed the one way, by confidenceOf, for every shape.
    // This used to say Math.max(yes, 1 - yes) here and call confidenceOf after
    // sampling, which are different numbers on different scales for the same
    // question: the first is a probability floored at 0.5, the second is
    // distance above chance starting at 0. Sampling is always on, so the second
    // is what actually got recorded, while the thresholds that read it had been
    // written meaning the first. A band set at 0.8 to mean "quite sure" was
    // silently demanding a peak of 0.90, and the check stayed quiet through 31
    // findings it had already made.
    return {
      answer: yes >= 0.5,
      confidence: confidenceOf({true: yes, false: 1 - yes}),
      distribution: [{option: true, probability: yes}, {option: false, probability: 1 - yes}],
    }
  }

  if (shape.kind === 'one-of') {
    if (typeof answered.choice !== 'string') return null
    return {
      answer: answered.choice,
      confidence: typeof answered.confidence === 'number' ? answered.confidence : null,
      distribution: spread(answered.probabilities),
    }
  }

  // A score arrives already weighted across the levels and may land between
  // them, so it is used as given rather than snapped to a level.
  if (typeof answered.score !== 'number') return null
  return {
    answer: answered.score,
    confidence: typeof answered.confidence === 'number' ? answered.confidence : null,
    distribution: spread(answered.probabilities),
  }
}

/** Read a batch reply back into one answer per id, keyed the way it was asked. */
export function outOfBatchReply(body, asking) {
  const answers = {}
  for (const [id, one] of Object.entries(asking)) {
    answers[id] = outOfReply({answers: {verdict: body?.answers?.[id]}}, one.shape)
  }
  return answers
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Ask several independent questions about one piece of content, in one trip. */
export async function askMany({candidate, content, asking}, post = fetch, options = {}) {
  const request = intoBatchRequest({content, asking})
  if (candidate?.reach?.model) request.model = candidate.reach.model
  const body = await send(request, post, {...options, reach: candidate?.reach})
  return outOfBatchReply(body, asking)
}

/**
 * How many times to ask the same question, because these answers are NOT
 * deterministic. Asking once and treating the reply as the model's view is a
 * mistake that hides as an answer: the same question can land either side of a
 * boundary on consecutive calls, and a calibration miss then looks like the
 * model being wrong when it was the sample being thin.
 *
 * Two by default. One is cheapest and noisiest; beyond a handful the averaging
 * stops paying for the extra calls.
 */
const SAMPLES = () => Math.min(5, Math.max(1, Number(process.env.CLASSIFIER_SAMPLES || 2)))

/**
 * Confidence from a distribution, by the provider's own formula: how far the
 * peak is above what a flat distribution would give. Computed here so an
 * averaged distribution gets an honest confidence rather than inheriting one
 * that belonged to a single sample.
 */
export function confidenceOf(probabilities) {
  const values = Object.values(probabilities || {})
  if (values.length < 2) return 1
  const peak = Math.max(...values)
  return Math.round(Math.min(1, Math.max(0, (values.length * peak - 1) / (values.length - 1))) * 10000) / 10000
}

/**
 * Average several samples of the same question into one answer, and report how
 * many of them agreed with it.
 *
 * Agreement is a different fact from confidence and neither substitutes for the
 * other. A peaked distribution says the model committed; agreement across
 * samples says it commits the same way twice. An answer that is confident every
 * time but differently each time is the one worth catching, and a single sample
 * cannot show it.
 */
export function averageSamples(samples, shape) {
  const usable = samples.filter(one => one && one.distribution && one.distribution.length > 0)
  if (usable.length === 0) return samples.find(one => one) ?? null
  const totals = new Map()
  for (const sample of usable) {
    for (const {option, probability} of sample.distribution) {
      totals.set(option, (totals.get(option) ?? 0) + (Number(probability) || 0) / usable.length)
    }
  }
  const averaged = Object.fromEntries(totals)
  const winner = [...totals.entries()].sort((left, right) => right[1] - left[1])[0][0]
  // A score is a position, so its samples are averaged as numbers rather than
  // resolved to whichever label won.
  const answer =
    shape.kind === 'score'
      ? usable.reduce((sum, one) => sum + Number(one.answer), 0) / usable.length
      : shape.kind === 'true-or-false'
        ? String(winner) === 'true'
        : winner
  const agreed = usable.filter(one => String(one.answer) === String(answer)).length / usable.length
  return {
    answer,
    confidence: confidenceOf(averaged),
    distribution: Object.entries(averaged).map(([option, probability]) => ({option, probability})),
    samples: usable.length,
    // How often the samples landed on the same answer. Reported, never folded
    // into confidence, because collapsing two measurements into one number is
    // how the more interesting of the two disappears.
    agreement: Math.round(agreed * 100) / 100,
  }
}

export async function ask(args, post = fetch, options = {}) {
  const howMany = options.samples ?? args?.candidate?.reach?.samples ?? SAMPLES()
  if (howMany <= 1) return askOnce(args, post, options)
  // Concurrently, because these are independent reads of the same question and
  // running them in sequence would turn a 200ms decision into a second.
  const results = await Promise.allSettled(
    Array.from({length: howMany}, () => askOnce(args, post, options)),
  )
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  const samples = results.map(result => result.value)
  // Agreement is meaningful only when every requested sample answered. One
  // surviving reply from two requests must not become `agreement: 1`.
  if (samples.some(sample => sample === null)) return null
  return averageSamples(samples, args.shape)
}

async function askOnce({candidate, question, shape, content}, post = fetch, options = {}) {
  const reach = candidate?.reach
  let body
  try {
    body = await send({...intoRequest({question, shape, content}), ...(reach?.model ? {model: reach.model} : {})}, post, {...options, reach})
  } catch (error) {
    const code = String(error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown')
    console.error('[classifier] request failed', JSON.stringify({
      error_code: /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'unknown',
    }))
    throw error
  }
  const answer = outOfReply(body, shape)
  if (answer === null) {
    const verdict = body?.answers?.verdict
    const expectedField = shape.kind === 'true-or-false' ? 'noul'
      : shape.kind === 'one-of' ? 'choice' : 'score'
    const metadata = body && typeof body === 'object' ? responseMetadata.get(body) : null
    console.error('[classifier] unusable answer', JSON.stringify({
      status: metadata?.status ?? null,
      content_type: metadata?.contentType ?? null,
      top_level_keys: safeResponseKeys(body),
      answers_type: valueType(body?.answers),
      verdict_type: valueType(verdict),
      expected_path: `answers.verdict.${expectedField}`,
      expected_type: valueType(verdict?.[expectedField]),
    }))
    throw new Error(
      `classifier response had no usable answer: status ${metadata?.status ?? 'unknown'}, ` +
      `answers ${valueType(body?.answers)}, verdict ${valueType(verdict)}, ` +
      `${expectedField} ${valueType(verdict?.[expectedField])}`,
    )
  }
  return answer
}

const responseMetadata = new WeakMap()
const valueType = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const DIAGNOSTIC_RESPONSE_KEYS = new Set(['answers', 'error', 'id', 'model', 'usage'])
const safeResponseKeys = (value) => value && typeof value === 'object'
  ? Object.keys(value).filter((key) => DIAGNOSTIC_RESPONSE_KEYS.has(key))
  : []

async function send(request, post, {attempts = 3, reach} = {}) {
  const where = reach?.endpoint || endpoint()
  const credential = reach?.credential || key()
  if (!credential) throw new Error('no credential is available, so there is nothing to ask')
  const body = JSON.stringify(request)

  for (let attempt = 1; ; attempt += 1) {
    const reply = await post(where, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
        // How long this caller will wait, so a server with a queue can skip
        // work nobody is waiting for any more instead of guessing.
        ...(reach?.timeoutSeconds > 0 ? {'x-answer-within-seconds': String(reach.timeoutSeconds)} : {}),
      },
      body,
      ...(reach?.timeoutSeconds > 0 ? {signal: AbortSignal.timeout(reach.timeoutSeconds * 1000)} : {}),
    })
    if (reply.ok) {
      const contentType = String(reply.headers?.get?.('content-type') ?? '').split(';')[0].slice(0, 80)
      let decoded
      try {
        decoded = await reply.json()
      } catch {
        console.error('[classifier] unusable response', JSON.stringify({
          status: reply.status,
          content_type: contentType,
          error_code: 'invalid_json',
        }))
        throw new Error('the classifier returned invalid JSON')
      }
      if (decoded && typeof decoded === 'object') {
        responseMetadata.set(decoded, {status: reply.status, contentType})
      }
      return decoded
    }

    // Busy is not wrong. Retrying immediately is what turns a busy moment into
    // a failed calibration, so these two back off and everything else is a
    // real answer about the request itself.
    const busy = reply.status === 429 || reply.status === 529
    if (!busy || attempt >= attempts) {
      console.error('[classifier] request refused', JSON.stringify({
        status: reply.status,
        content_type: String(reply.headers?.get?.('content-type') ?? '').split(';')[0].slice(0, 80),
        error_code: busy ? 'busy_retries_exhausted' : 'http_non_ok',
      }))
      throw new Error(
        `the classifier answered ${reply.status}` +
          (reply.status === 401
            ? ': the key was missing or rejected'
            : reply.status === 422
              ? ': the request did not validate, so a question is malformed'
              : ''),
      )
    }
    await wait(250 * 2 ** (attempt - 1))
  }
}
