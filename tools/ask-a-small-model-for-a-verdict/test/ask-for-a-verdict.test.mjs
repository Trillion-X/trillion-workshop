// Proof for ask-for-a-verdict.mjs.
//
// The load-bearing test in this file is the yes-man: a classifier that answers
// "true" to everything must be REJECTED. If it is accepted, every verdict this
// package ever returns is worthless, and worse than worthless, because it
// arrives with the shape of a real check. Everything else here is secondary to
// that one case.
//
// No test needs a server or a key. The classifier call is an argument.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {
  VerdictRefused,
  NothingPassedCalibration,
  SHAPES,
  bandFor,
  checkRubric,
  checkFits,
  scoreCandidate,
  describeScoreboard,
  chooseCandidate,
  judge,
  run,
} from '../do-work/ask-for-a-verdict.mjs'
import {intoRequest, outOfReply, intoBatchRequest, outOfBatchReply, askMany, ask as askHosted} from '../do-work/ask-a-hosted-classifier.mjs'
import {candidates as locallyServedCandidates, ask as askLocallyServed} from '../do-work/ask-a-locally-served-model.mjs'

test('local adapter reads the provider DATA row: where the server is and how long a request may take', async () => {
  let requested
  const offered = await locallyServedCandidates(
    {endpoint: 'http://127.0.0.1:11434', timeout_seconds: 3},
    async url => {
      requested = url
      return {models: [{name: 'small-chat', size: 2}]}
    },
  )
  assert.equal(requested, 'http://127.0.0.1:11434/api/tags')
  assert.deepEqual(offered, [{name: 'small-chat', size: 2, reach: {endpoint: 'http://127.0.0.1:11434', timeoutSeconds: 3}}])
})

test('a local request limit comes from the provider DATA row', async () => {
  const offered = await locallyServedCandidates({endpoint: 'http://x', timeout_seconds: 9}, async () => ({models: [{name: 'm'}]}))
  assert.equal(offered[0].reach.timeoutSeconds, 9)
})

function memoryInAMap() {
  const held = new Map()
  return {held, get: key => held.get(key) ?? null, set: (key, value) => {const stored = {...value, at: new Date().toISOString()}; held.set(key, stored); return {status: 'stored', value: stored}}}
}

test('a finished calibration that nothing passed is told apart, so a hook can stay quiet about it', async () => {
  const remember = memoryInAMap()
  const rubric = checkRubric(RUBRIC)
  await assert.rejects(() => chooseCandidate({candidates: one('agreeable'), rubric, ask: alwaysSays(true), passes: 1, remember}))
  let asked = 0
  await assert.rejects(
    () => chooseCandidate({candidates: one('agreeable'), rubric, ask: async () => { asked += 1; return {answer: true} }, passes: 1, remember, calibrate: false}),
    error => error instanceof NothingPassedCalibration,
  )
  assert.equal(asked, 0, 'nothing is asked once calibration has said no judge passes')
})

test('a calibration cut off part way resumes instead of starting over', async () => {
  const remember = memoryInAMap()
  const asked = []
  const rubric = checkRubric(RUBRIC)
  const candidates = [{name: 'wrong'}, {name: 'right'}]
  const ask = async ({candidate, content}) => {
    asked.push(candidate.name)
    const expect = rubric.cases.find(one => one.content === content).expect
    return {answer: candidate.name === 'right' ? expect : !expect}
  }
  // First fire: only the losing candidate is offered a chance before the cut.
  await assert.rejects(() => chooseCandidate({candidates: candidates.slice(0, 1), rubric, ask, passes: 1, remember}))
  const key = [...remember.held.keys()][0]
  // The same key with the full list is what a later fire sees; seed it as the cut-off fire left it.
  const {calibrationKey} = await import('../do-work/ask-for-a-verdict.mjs')
  remember.held.set(calibrationKey(rubric, candidates, 1), remember.held.get(key))
  asked.length = 0
  const {chosen} = await chooseCandidate({candidates, rubric, ask, passes: 1, remember})
  assert.equal(chosen.name, 'right')
  assert.ok(!asked.includes('wrong'), 'the candidate already scored was not asked again')
})

test('a choice decided only because the preferred candidate was unreachable is not remembered', async () => {
  const remember = memoryInAMap()
  const rubric = checkRubric(RUBRIC)
  const ask = async ({candidate, content}) => {
    if (candidate.name === 'down') throw new Error('the classifier answered 402')
    return {answer: rubric.cases.find(one => one.content === content).expect}
  }
  const {chosen} = await chooseCandidate({candidates: [{name: 'down'}, {name: 'up'}], rubric, ask, passes: 1, remember})
  assert.equal(chosen.name, 'up')
  assert.ok(![...remember.held.values()].some(row => row.chosen), 'no candidate was pinned')
  assert.equal([...remember.held.values()][0].scoreboard.at(-1).candidate, 'up')
  assert.equal([...remember.held.values()][0].scoreboard.at(-1).passed, true, 'the fallback trial survives without pinning it')
})

test('local chat requests the rubric answer type from the model server', async () => {
  let sent
  const result = await askLocallyServed({
    candidate: {name: 'small-chat', reach: {endpoint: 'http://127.0.0.1:11434', timeoutSeconds: 3}},
    question: 'Is the work complete?',
    shape: {kind: 'true-or-false'},
    content: 'Work is complete.',
  }, async (_url, request) => {
    sent = JSON.parse(request.body)
    return {json: async () => ({message: {content: '{"answer":true}'}})}
  })
  assert.equal(sent.format.properties.answer.type, 'boolean')
  assert.deepEqual(sent.format.required, ['answer'])
  assert.equal(result.answer, true)
})

test('hosted request failures remain actionable after repeated samples', async () => {
  await assert.rejects(
    askHosted({
      candidate: {reach: {endpoint: 'https://example.invalid', model: 'test', credential: 'test'}},
      question: 'Is the work complete?',
      shape: {kind: 'true-or-false'},
      content: 'Work is complete.',
    }, async () => ({ok: false, status: 402, headers: {get: () => 'application/json'}}), {samples: 2}),
    /the classifier answered 402/,
  )
})

test('server token-budget refusal remains no verdict and is never retried or trimmed', async () => {
  const content = 'alpha '.repeat(4300) + ' FINAL_MARKER_RED'
  let calls = 0
  await assert.rejects(askHosted({
    candidate: {reach: {endpoint: 'https://example.invalid', model: 'test', credential: 'test'}},
    question: 'Which final marker is present?',
    shape: {kind: 'one-of', options: ['RED', 'BLUE']},
    content,
  }, async (_url, request) => {
    calls += 1
    assert.equal(JSON.parse(request.body).state, content)
    return {ok: false, status: 413, headers: {get: () => 'application/json'}}
  }, {samples: 1}), /complete input exceeds the server token budget; no verdict was produced/)
  assert.equal(calls, 1)
})

test('one successful sample cannot certify agreement after another fails', async () => {
  let count = 0
  await assert.rejects(
    askHosted({
      candidate: {reach: {endpoint: 'https://example.invalid', model: 'test', credential: 'test'}},
      question: 'Is the work complete?',
      shape: {kind: 'true-or-false'},
      content: 'Work is complete.',
    }, async () => ++count === 1
      ? {ok: false, status: 402, headers: {get: () => 'application/json'}}
      : {ok: true, status: 200, headers: {get: () => 'application/json'}, json: async () => ({answers: {verdict: {noul: 0.9}}})},
    {samples: 2}),
    /the classifier answered 402/,
  )
})

test('a batched verdict uses the selected candidate model even after another candidate is configured', async () => {
  let sent
  await askMany({
    candidate: {reach: {endpoint: 'https://example.invalid', model: 'first-model', credential: 'test', samples: 1}},
    content: 'sample',
    asking: {fit: {question: 'Does it fit?', shape: {kind: 'true-or-false'}}},
  }, async (_url, request) => {
    sent = JSON.parse(request.body)
    return {ok: true, json: async () => ({answers: {fit: {noul: 0.8}}})}
  })
  assert.equal(sent.model, 'first-model')
})
import {readAnswer} from '../do-work/ask-a-locally-served-model.mjs'
import {judgeContent, contentReviewIdentity} from '../do-work/judge-content.mjs'

const RUBRIC = {
  id: 'did-it-do-what-was-asked',
  question: 'Does the work described meet the request?',
  answer_shape: {kind: 'true-or-false'},
  calibration: [
    {content: 'asked for a table; built a table', expect: true},
    {content: 'asked for a table; wrote a note saying a table would be good', expect: false},
  ],
}

const one = name => [{name}]

/** A classifier that always says the same thing, which is the cheapest wrong judge. */
const alwaysSays = value => async () => ({answer: value, confidence: 0.99})

/** One that actually reads the case. */
const honest = async ({content}) => ({answer: content.includes('built a table'), confidence: 0.9})

test('callable semantic gate returns an auditable verdict and honors DATA acceptance', async () => {
  const result = await judgeContent({
    rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content: 'asked for a table; built a table',
    candidates: one('reader'),
    ask: honest,
    passes: 2,
  })
  assert.equal(result.accepted, true)
  assert.equal(result.reason, null)
  assert.equal(result.answer, true)
  assert.equal(result.answered_by, 'reader')
  assert.equal(result.calibration.cases, 2)
})

test('callable semantic gate keeps the acceptance policy captured before asynchronous review', async () => {
  const rubric = {...RUBRIC, accept_when_answer_in: [true]}
  const result = await judgeContent({rubric,
    content: 'asked for a table; wrote a note saying a table would be good',
    candidates: one('reader'), passes: 1,
    ask: async args => {
      rubric.accept_when_answer_in[0] = false
      return honest(args)
    },
  })
  assert.equal(result.answer, false)
  assert.equal(result.accepted, false, 'a late policy change cannot approve the rejected content')
})

test('content review binds the exact supplied material and policy without retaining private text', async () => {
  const input = {rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content: 'asked for a table; built a table PRIVATE_SOURCE_OR_RATIONALE', passes: 1,
    content_parts: [{kind: 'addressed-content', address: 'original', source: {hash: 'original'}}]}
  const identity = contentReviewIdentity(input)
  const result = await judgeContent({...input, candidates: one('reader'), ask: async args => {
    input.rubric.accept_when_answer_in[0] = false
    input.content_parts[0].source.hash = 'replacement'
    if (args.content === input.content) {
      assert.equal(args.content_parts[0].source.hash, 'original', 'actual request uses its captured descriptors')
    }
    return honest(args)
  }})
  assert.equal(result.accepted, true, 'late rejection policy cannot alter the captured policy either')
  assert.equal(result.review_binding.input_identity, identity)
  assert.match(result.review_binding.judge_source_snapshot, /^blake3:[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(result.review_binding).includes('PRIVATE_SOURCE_OR_RATIONALE'), false)
  assert.notEqual(contentReviewIdentity(input), identity)
  const original = {...input, rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content_parts: [{kind: 'addressed-content', address: 'original', source: {hash: 'original'}}]}
  assert.equal(contentReviewIdentity(original), identity)
  assert.equal(contentReviewIdentity({...original, rubric: Object.fromEntries(Object.entries(original.rubric).reverse())}), identity)
  for (const changed of [{content: original.content + ' changed owner/contract/path'}, {passes: 2}, {sureAt: 0.9},
    {rubric: {...original.rubric, accept_when_answer_in: [false]}},
    {content_parts: [{...original.content_parts[0], address: 'another'}]}]) {
    assert.notEqual(contentReviewIdentity({...original, ...changed}), identity)
  }
})

test('content review refuses lossy or executable material before any classifier call', async () => {
  const cycle = {}; cycle.self = cycle
  let accessed = 0, asked = 0
  const accessor = Object.defineProperty({}, 'text', {enumerable: true, get() {accessed++; return 'hidden'}})
  const hidden = Object.defineProperty({}, 'text', {value: 'hidden'})
  for (const part of [cycle, accessor, hidden, {value: undefined}, {value: NaN}, {value: -0},
    {[Symbol('hidden')]: 'hidden'}, new Date(), [, 'hole'], Object.assign([], {extra: 'hidden'}),
    Object.assign([, 'hole'], {extra: 'hidden'})]) {
    await assert.rejects(() => judgeContent({rubric: {...RUBRIC, accept_when_answer_in: [true]},
      content: 'asked for a table; built a table', content_parts: [part],
      candidates: one('reader'), ask: async args => {asked++; return honest(args)}}), VerdictRefused)
  }
  assert.equal(accessed, 0)
  assert.equal(asked, 0)
})

test('content review refuses top-level accessors without evaluating them', async () => {
  let accessed = 0, asked = 0
  const ordinary = {rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content: 'asked for a table; built a table', candidates: one('reader'),
    ask: async args => {asked++; return honest(args)}}
  for (const key of ['rubric', 'content', 'content_parts', 'passes', 'sureAt', 'candidates', 'ask', 'providers']) {
    const input = {...ordinary}
    Object.defineProperty(input, key, {enumerable: true, get() {accessed++; return ordinary[key]}})
    await assert.rejects(() => judgeContent(input), VerdictRefused)
    if (['rubric', 'content', 'content_parts', 'passes', 'sureAt'].includes(key)) {
      assert.throws(() => contentReviewIdentity(input), VerdictRefused)
    }
  }
  assert.equal(accessed, 0)
  assert.equal(asked, 0)
})

test('inherited JSON serialization cannot substitute different review material', async () => {
  let transformed = 0, asked = 0
  const before = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
  try {
    Object.defineProperty(Array.prototype, 'toJSON', {configurable: true,
      value() {transformed++; return 'substituted material'}})
    const input = {rubric: {...RUBRIC, accept_when_answer_in: [true]}, content: 'good',
      candidates: one('reader'), ask: async () => {asked++; return {answer: true}}}
    assert.throws(() => contentReviewIdentity(input), VerdictRefused)
    await assert.rejects(() => judgeContent(input), VerdictRefused)
  } finally {
    if (before) Object.defineProperty(Array.prototype, 'toJSON', before)
    else delete Array.prototype.toJSON
  }
  assert.equal(transformed, 0)
  assert.equal(asked, 0)
})

test('content review captures candidate route DATA before calibration yields', async () => {
  const candidate = {name: 'original reader', reach: {endpoint: 'http://original.invalid'}}
  const seen = []
  const result = await judgeContent({rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content: 'asked for a table; built a table', candidates: [candidate], passes: 1,
    ask: async args => {
      candidate.name = 'replaced reader'
      candidate.reach.endpoint = 'http://replaced.invalid'
      seen.push([args.candidate.name, args.candidate.reach.endpoint])
      return honest(args)
    }})
  assert.equal(result.accepted, true)
  assert.equal(result.answered_by, 'original reader')
  assert.equal(seen.length, 3)
  assert.ok(seen.every(([name, endpoint]) => name === 'original reader' && endpoint === 'http://original.invalid'))
})

test('changed inherited array methods cannot redefine captured acceptance', async () => {
  const original = Array.prototype.some
  let result
  try {
    result = await judgeContent({rubric: {...RUBRIC, accept_when_answer_in: [false]},
      content: 'asked for a table; built a table', candidates: one('reader'), passes: 1,
      ask: async args => {
        Array.prototype.some = function (...given) {
          return this.length === 1 && this[0] === false ? true : original.apply(this, given)
        }
        return honest(args)
      }})
  } finally {Array.prototype.some = original}
  assert.equal(result.answer, true)
  assert.equal(result.accepted, false)
})

test('captured acceptance preserves exact score equality for a negative-zero answer', async () => {
  const result = await judgeContent({rubric: {id: 'score-fixture', question: 'Which score?',
    answer_shape: {kind: 'score', levels: ['low', 'high']}, score_tolerance: 0, accept_when_answer_in: [0],
    calibration: [{content: 'low', expect: 0}, {content: 'high', expect: 1}]},
    content: 'negative zero', candidates: one('reader'), passes: 1,
    ask: async ({content}) => ({answer: content === 'low' ? 0 : content === 'high' ? 1 : -0})})
  assert.ok(Object.is(result.answer, -0))
  assert.equal(result.accepted, false)
})

test('screenshot judgement calibrates on opposed addressed vision examples and forwards the real capture', async () => {
  const capture = address => ({
    kind: 'addressed-content', address, content_kind: 'vision',
    source: {kind: 'blob_ref', hash: `1f:${address}`}, mount_path: `${address}.png`,
    mime_type: 'image/png', byte_length: 10, integrity_hash: `1f:${address}`, delivery: {kind: 'inline-base64'},
  })
  const rubric = {
    ...RUBRIC,
    question: 'Does the screenshot show the requested result?',
    accept_when_answer_in: [true],
    calibration: [
      {content: 'Expected completed screen', content_parts: [capture('calibration:completed')], expect: true},
      {content: 'Expected incomplete screen', content_parts: [capture('calibration:incomplete')], expect: false},
    ],
  }
  const seen = []
  const actual = capture('capture:current')
  const result = await judgeContent({
    rubric,
    content: 'Review the current screen.',
    content_parts: [actual],
    candidates: one('vision-reader'),
    ask: async args => {
      seen.push(args.content_parts?.[0]?.address)
      return {answer: args.content_parts?.[0]?.address !== 'calibration:incomplete'}
    },
    passes: 1,
  })
  assert.equal(result.accepted, true)
  assert.deepEqual(seen, [
    'calibration:completed', 'calibration:incomplete', 'capture:current',
  ])
})

test('screenshot judgement refuses text-only calibration examples', async () => {
  await assert.rejects(
    () => judgeContent({
      rubric: {...RUBRIC, accept_when_answer_in: [true]},
      content: 'Review the current screen.',
      content_parts: [{kind: 'addressed-content', content_kind: 'vision'}],
      candidates: one('text-only-reader'),
      ask: honest,
      passes: 1,
    }),
    /opposed calibration cases that each include addressed vision content/,
  )
})

test('local adapter refuses unsupported content parts before sending a text-only request', async () => {
  let posts = 0
  const post = async () => {
    posts++
    return {json: async () => ({message: {content: '{"answer":true}'}})}
  }
  const candidate = {name: 'synthetic-local', reach: {timeoutSeconds: 1}}
  for (const content_parts of [null, {}, [null],
    [{kind: 'addressed-content', content_kind: 'vision', mount_path: 'unreadable.png'}],
    [{kind: 'addressed-content', content_kind: 'text', address: 'required-context'}]]) {
    await assert.rejects(() => askLocallyServed({candidate, question: 'Does the supplied evidence meet the task?',
      shape: {kind: 'true-or-false'}, content: 'Review the supplied evidence.', content_parts}, post),
    /local classifier transport does not support supplied content parts/)
  }
  assert.equal(posts, 0, 'unsupported or unreadable descriptors must never become a text-only request')
  assert.deepEqual(await askLocallyServed({candidate, question: 'Is this text sufficient?',
    shape: {kind: 'true-or-false'}, content: 'A complete text-only input.', content_parts: []}, post),
  {answer: true, confidence: null, distribution: null})
  assert.equal(posts, 1, 'the ordinary text-only adapter remains useful')
})

test('local full review cannot qualify screenshot evidence through text-only HTTP payloads', async t => {
  const requests = []
  let visionRequestCount = null, textReviewAccepted = null
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    const sent = JSON.parse(body)
    requests.push(sent)
    // Deliberately answer from text alone. These are exposed transport
    // fixtures, never image labels, an actual model or accuracy evidence.
    const text = sent.messages.at(-1).content
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({message: {content: JSON.stringify({answer: !text.includes('incomplete')})}}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const capture = address => ({kind: 'addressed-content', content_kind: 'vision', address,
    source: {kind: 'blob_ref', hash: '1f:synthetic-descriptor'}, mount_path: 'unreadable.png',
    mime_type: 'image/png', byte_length: 10, integrity_hash: '1f:synthetic-descriptor', delivery: {kind: 'inline-base64'}})
  const rubric = {...RUBRIC, id: 'local-vision-observation-fixture',
    question: 'Does the screenshot meet the requested result?', accept_when_answer_in: [true],
    calibration: [
      {content: 'Expected completed screen', content_parts: [capture('fixture:completed')], expect: true},
      {content: 'Expected incomplete screen', content_parts: [capture('fixture:incomplete')], expect: false},
    ]}
  try {
    await assert.rejects(() => judgeContent({rubric, content: 'Review the current screen.',
      content_parts: [capture('fixture:current')], passes: 1,
      providers: [{via: 'locally-served', endpoint: `http://127.0.0.1:${server.address().port}`, timeout_seconds: 1}],
      // Inventory is synthetic; request delivery uses the actual adapter HTTP
      // path without inference, external services or a paid provider.
      candidates: [{name: 'synthetic-local', reach: {endpoint: `http://127.0.0.1:${server.address().port}`, timeoutSeconds: 1}}],
      ask: askLocallyServed}).then(result => {
        t.diagnostic(`local-vision-consumer-result: ${JSON.stringify({accepted: result.accepted, answer: result.answer})}`)
        return result
      }), error => error instanceof VerdictRefused && /no candidate answered every calibration case/.test(error.message))
    assert.equal(requests.length, 0, 'calibration must refuse before discarding the first capture')
    visionRequestCount = requests.length
    const textRubric = {...rubric, id: 'local-text-observation-fixture', question: 'Does the text meet the request?',
      calibration: rubric.calibration.map(({content, expect}) => ({content, expect}))}
    const textResult = await judgeContent({rubric: textRubric, content: 'Review the current text.',
      content_parts: [], passes: 1,
      candidates: [{name: 'synthetic-local', reach: {endpoint: `http://127.0.0.1:${server.address().port}`, timeoutSeconds: 1}}],
      ask: askLocallyServed})
    textReviewAccepted = textResult.accepted
    assert.equal(textReviewAccepted, true)
    assert.equal(requests.length, 3, 'opposed text calibration and actual text review use the ordinary HTTP path')
    assert.deepEqual(requests.map(one => one.messages.at(-1).content),
      ['Expected completed screen', 'Expected incomplete screen', 'Review the current text.'])
  } finally {
    t.diagnostic(`local-vision-transport-fixture: ${JSON.stringify({visionRequestCount, textReviewAccepted, requests})}`)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('callable semantic gate rejects an answer outside rubric acceptance DATA', async () => {
  const result = await judgeContent({
    rubric: {...RUBRIC, accept_when_answer_in: [true]},
    content: 'asked for a table; wrote a note saying a table would be good',
    candidates: one('reader'),
    ask: honest,
    passes: 2,
  })
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'answer_not_accepted_by_rubric')
  assert.equal(result.answer, false)
})

test('callable semantic gate refuses rubric DATA with no acceptance outcomes', async () => {
  await assert.rejects(
    () => judgeContent({rubric: RUBRIC, content: 'draft', candidates: one('reader'), ask: honest}),
    /must declare non-empty accept_when_answer_in DATA/,
  )
})

test('a classifier that says yes to everything is REJECTED, not accepted as a judge', async () => {
  await assert.rejects(
    () => chooseCandidate({candidates: one('agreeable'), rubric: checkRubric(RUBRIC), ask: alwaysSays(true), passes: 2}),
    error => error instanceof VerdictRefused && /no candidate answered every calibration case/.test(error.message),
  )
})

test('one that says no to everything is rejected the same way, and high confidence does not save it', async () => {
  await assert.rejects(
    () => chooseCandidate({candidates: one('contrary'), rubric: checkRubric(RUBRIC), ask: alwaysSays(false), passes: 2}),
    /no candidate answered every calibration case/,
  )
})

test('a rubric cannot qualify when its actual consumer lacks required observable context', () => {
  assert.throws(() => checkRubric({...RUBRIC, unavailable_context: 'No actual definition-read receipts are supplied.'}),
    error => error instanceof VerdictRefused && /observable context is unavailable/.test(error.message))
})

test('a rubric with no calibration cases is refused, because it would agree with everything', () => {
  assert.throws(
    () => checkRubric({...RUBRIC, calibration: []}),
    error => error instanceof VerdictRefused && /agrees with everything/.test(error.message),
  )
})

test('a rubric whose cases all expect the same answer is refused', () => {
  assert.throws(
    () =>
      checkRubric({
        ...RUBRIC,
        calibration: [{content: 'a', expect: true}, {content: 'b', expect: true}],
      }),
    /always answers that way passes all of them/,
  )
})

test('a rubric with no question, no shape, or an unusable shape is refused', () => {
  assert.throws(() => checkRubric({...RUBRIC, question: '   '}), /must carry a `question`/)
  assert.throws(() => checkRubric({...RUBRIC, answer_shape: undefined}), /must declare an `answer_shape.kind`/)
  assert.throws(
    () => checkRubric({...RUBRIC, answer_shape: {kind: 'one-of', options: ['only-one']}}),
    /a menu of one is not a question/,
  )
})

test('a calibration case expecting something the shape cannot produce is refused', () => {
  assert.throws(
    () =>
      checkRubric({
        ...RUBRIC,
        calibration: [{content: 'a', expect: 'yes'}, {content: 'b', expect: false}],
      }),
    /which is not either true or false/,
  )
})

test('a classifier that reads the case is chosen, and its verdict comes back', async () => {
  const result = await judge({
    rubric: RUBRIC,
    content: 'asked for a table; built a table',
    candidates: one('reader'),
    ask: honest,
    passes: 2,
  })
  assert.equal(result.answered_by, 'reader')
  assert.equal(result.answer, true)
  assert.equal(result.confidence, 0.9)
  assert.equal(result.calibration.cases, 2)
})

test('the verdict actually tracks the content, so it is not a fixed answer', async () => {
  const bad = await judge({
    rubric: RUBRIC,
    content: 'asked for a table; wrote a note saying a table would be good',
    candidates: one('reader'),
    ask: honest,
    passes: 2,
  })
  assert.equal(bad.answer, false)
})

test('the first passing candidate wins, and later ones are never reached', async () => {
  const asked = []
  const ask = async args => {
    asked.push(args.candidate.name)
    return honest(args)
  }
  const result = await judge({
    rubric: RUBRIC,
    content: 'asked for a table; built a table',
    candidates: [{name: 'small'}, {name: 'large'}],
    ask,
    passes: 2,
  })
  assert.equal(result.answered_by, 'small')
  assert.ok(!asked.includes('large'), 'a later candidate must not be tried once an earlier one has passed')
})

test('one that never answers is counted as erroring, not as answering wrongly', async () => {
  const score = await scoreCandidate({
    candidate: {name: 'silent'},
    rubric: checkRubric(RUBRIC),
    ask: async () => {
      throw new Error('timed out')
    },
    passes: 1,
  })
  assert.equal(score.correct, 0)
  assert.equal(score.errors, 1, 'the first no-answer makes this all-correct bar impossible')
  assert.equal(score.asked, 1)
  assert.equal(score.attempts, 2, 'the unasked case stays in the planned denominator')
  assert.equal(score.stopped_early, true)
  assert.equal(score.passed, false)
})

test('one-pass failure stops at the first impossible result and keeps planned versus observed counts distinct', async () => {
  const input = {...RUBRIC, calibration: Array.from({length: 8}, (_, i) => ({content: `synthetic-case-${i}`, expect: i % 2 === 0}))}
  let calls = 0
  const score = await scoreCandidate({candidate: {name: 'known-wrong'}, rubric: checkRubric(input), passes: 1,
    ask: async () => {calls++; return {answer: false}}})
  assert.equal(calls, 1)
  assert.equal(score.correct, 0)
  assert.equal(score.errors, 0, 'a wrong answer remains distinct from no answer')
  assert.equal(score.asked, 1)
  assert.equal(score.attempts, 8)
  assert.equal(score.needed, 8)
  assert.equal(score.passed, false)
  assert.equal(score.stopped_early, true)
  assert.match(describeScoreboard([score]), /0\/1 asked; 8 planned; 7 unasked/)
  assert.match(describeScoreboard([{candidate: 'historical', correct: 2, attempts: 8}]), /2 correct; asked unknown; 8 planned/)
})

test('a declared lower bar continues while recovery is possible, refuses when impossible, and completes a passing corpus', async () => {
  const input = {...RUBRIC, pass_when_share_correct: .75,
    calibration: Array.from({length: 8}, (_, i) => ({content: `synthetic-case-${i}`, expect: i % 2 === 0}))}
  let calls = 0
  const impossible = await scoreCandidate({candidate: {name: 'failed'}, rubric: checkRubric(input), passes: 1,
    ask: async ({content}) => {calls++; return {answer: Number(content.split('-').at(-1)) % 2 !== 0}}})
  assert.equal(calls, 3, 'after two losses all six remaining answers could still satisfy the original bar')
  assert.equal(impossible.asked, 3)
  assert.equal(impossible.needed, 6)
  assert.equal(impossible.passed, false)
  calls = 0
  const recovered = await scoreCandidate({candidate: {name: 'passes'}, rubric: checkRubric(input), passes: 1,
    ask: async ({content}) => {const i = Number(content.split('-').at(-1)); calls++; return {answer: i < 2 ? i % 2 !== 0 : i % 2 === 0}}})
  assert.equal(calls, 8, 'successful qualification still asks the full declared corpus')
  assert.equal(recovered.correct, 6)
  assert.equal(recovered.asked, 8)
  assert.equal(recovered.needed, 6)
  assert.equal(recovered.passed, true)
  assert.equal(recovered.stopped_early, false)
})

test('scoring stops as soon as a candidate cannot pass, since the rest are paid round trips', async () => {
  let calls = 0
  await scoreCandidate({
    candidate: {name: 'wrong'},
    rubric: checkRubric(RUBRIC),
    ask: async () => {
      calls += 1
      return {answer: true}
    },
    passes: 5,
  })
  assert.ok(calls <= 2, `a settled verdict must stop the rounds, took ${calls} calls`)
})

test('offering no candidate at all is refused rather than answered', async () => {
  await assert.rejects(
    () => chooseCandidate({candidates: [], rubric: checkRubric(RUBRIC), ask: honest, passes: 1}),
    /no candidate classifier was offered/,
  )
})

test('one that passed calibration but then answers out of shape is refused, never guessed for', async () => {
  let seen = 0
  const ask = async args => {
    seen += 1
    return seen <= 4 ? honest(args) : {answer: 'maybe'}
  }
  await assert.rejects(
    () => judge({rubric: RUBRIC, content: 'the real thing', candidates: one('flaky'), ask, passes: 2}),
    /passed calibration but then answered "maybe"/,
  )
})

test('content larger than the classifier can read is REFUSED, never trimmed to fit', async () => {
  await assert.rejects(
    () =>
      judge({
        rubric: RUBRIC,
        content: 'x'.repeat(500),
        candidates: [{name: 'small-window', accepts_characters: 100}],
        ask: honest,
        passes: 1,
      }),
    error => error instanceof VerdictRefused && /Split the content/.test(error.message),
  )
})

test('a candidate that declares no reading limit accepts anything', () => {
  assert.doesNotThrow(() => checkFits('x'.repeat(10000), {name: 'unbounded'}))
})

test('confidence lands in the band the rubric declared, so a middling answer goes to a person', async () => {
  const banded = {
    ...RUBRIC,
    confidence_bands: [
      {at_least: 0.7, then: 'act'},
      {at_least: 0.35, then: 'ask-a-person'},
      {at_least: 0, then: 'ignore'},
    ],
  }
  const at = value => async ({content}) => ({answer: content.includes('built a table'), confidence: value})
  const sure = await judge({rubric: banded, content: 'asked for a table; built a table', candidates: one('c'), ask: at(0.92), passes: 1})
  assert.equal(sure.band, 'act')
  const middling = await judge({rubric: banded, content: 'asked for a table; built a table', candidates: one('c'), ask: at(0.5), passes: 1})
  assert.equal(middling.band, 'ask-a-person')
  const weak = await judge({rubric: banded, content: 'asked for a table; built a table', candidates: one('c'), ask: at(0.1), passes: 1})
  assert.equal(weak.band, 'ignore')
})

test('bandFor returns nothing when the rubric drew no lines, rather than inventing one', () => {
  assert.equal(bandFor(0.9, null), null)
})

test('AN ANSWER WITH NO PROBABILITY STILL LANDS IN A BAND THE RUBRIC CHOSE', async () => {
  // The defect this catches made the whole thing inert. A classifier that
  // returns no probability produced a null band, every band test failed, and
  // nothing was ever raised. The check was green and had never once fired.
  // Caught only because the verdicts were logged and the nulls were visible.
  const bands = [{at_least: 0.8, then: 'raise-it'}, {at_least: 0, then: 'let-it-pass'}]
  assert.equal(bandFor(null, bands), null, 'with no instruction, still nothing')
  assert.equal(bandFor(null, bands, 'raise-it'), 'raise-it', 'the rubric says where an unmeasured answer goes')

  const rubric = {...RUBRIC, confidence_bands: bands, band_when_confidence_unknown: 'raise-it'}
  const silentAboutConfidence = async ({content}) => ({answer: content.includes('built a table')})
  const result = await judge({
    rubric,
    content: 'asked for a table; built a table',
    candidates: one('quiet'),
    ask: silentAboutConfidence,
    passes: 1,
  })
  assert.equal(result.confidence, null)
  assert.equal(result.band, 'raise-it', 'a text model answering honestly must not silently disable the check')
})

test('the whole distribution survives, not only the winning option', async () => {
  const spread = [{option: true, probability: 0.61}, {option: false, probability: 0.39}]
  const result = await judge({
    rubric: RUBRIC,
    content: 'asked for a table; built a table',
    candidates: one('c'),
    ask: async ({content}) => ({answer: content.includes('built a table'), confidence: 0.61, distribution: spread}),
    passes: 1,
  })
  assert.deepEqual(result.distribution, spread)
})

test('every verdict carries enough to go back to it later', async () => {
  const result = await judge({
    rubric: RUBRIC,
    content: 'asked for a table; built a table',
    candidates: one('c'),
    ask: honest,
    passes: 1,
    now: () => new Date('2026-09-21T10:00:00Z'),
  })
  assert.equal(result.asked_at, '2026-09-21T10:00:00.000Z')
  assert.equal(result.rubric_id, 'did-it-do-what-was-asked')
  assert.equal(result.asked_about.characters, 'asked for a table; built a table'.length)
  assert.equal(result.asked_about.question, RUBRIC.question)
})

test('a choice rubric carries each option description, since that changes the answer', () => {
  const shape = {
    kind: 'one-of',
    options: [
      {name: 'billing', description: 'the charge itself is wrong'},
      {name: 'technical', description: 'whoever must fix the root cause'},
    ],
  }
  assert.ok(SHAPES['one-of'].valid(shape))
  assert.deepEqual(SHAPES['one-of'].choices(shape).map(o => o.description), [
    'the charge itself is wrong',
    'whoever must fix the root cause',
  ])
  const request = intoRequest({question: 'which team', shape, content: 'the export button double charged me'})
  assert.equal(request.questions.verdict.type, 'choice')
  assert.equal(request.questions.verdict.instructions, 'which team')
  assert.deepEqual(request.questions.verdict.criteria, {
    billing: 'the charge itself is wrong',
    technical: 'whoever must fix the root cause',
  })
})

test('a choice past the option ceiling is refused with the number, not sent and rejected', () => {
  const shape = {kind: 'one-of', options: Array.from({length: 256}, (unused, index) => `option-${index}`)}
  assert.throws(() => intoRequest({question: 'q', shape, content: 'c'}), /at most 255 options and this one has 256/)
})

test('a score past the level ceiling is refused the same way', () => {
  const shape = {kind: 'score', levels: Array.from({length: 11}, (unused, index) => `level-${index}`)}
  assert.throws(() => intoRequest({question: 'q', shape, content: 'c'}), /at most 10 levels and this one has 11/)
})

test('a yes/no question carries no criteria unless it needs it, and is asked as a noul', () => {
  const request = intoRequest({question: 'is this urgent', shape: {kind: 'true-or-false'}, content: 'help!'})
  assert.equal(request.questions.verdict.type, 'noul')
  assert.equal(request.model, undefined, 'a model is supplied by the calibrated provider row, not a retired default')
  assert.equal(request.state, 'help!')
})

test('a confident NO is read as confident, not as an unsure yes', () => {
  const shape = {kind: 'true-or-false'}
  const yes = outOfReply({answers: {verdict: {type: 'noul', noul: 0.95}}}, shape)
  assert.equal(yes.answer, true)
  assert.equal(yes.confidence, 0.9)
  const no = outOfReply({answers: {verdict: {type: 'noul', noul: 0.05}}}, shape)
  assert.equal(no.answer, false)
  // The load-bearing number. Reading 0.05 as the confidence would make this
  // firmly-answered question look like the least certain thing in the system.
  assert.equal(Math.round(no.confidence * 100) / 100, 0.9)
  const unsure = outOfReply({answers: {verdict: {type: 'noul', noul: 0.5}}}, shape)
  assert.equal(unsure.confidence, 0)
})

test('a score answer between two levels is kept as given, never snapped to a level', () => {
  const shape = {kind: 'score', levels: ['Calm', 'Frustrated', 'Very angry']}
  const read = outOfReply(
    {answers: {verdict: {type: 'score', score: 1.05, probabilities: {0: 0.0, 1: 0.95, 2: 0.05}, confidence: 0.92}}},
    shape,
  )
  assert.equal(read.answer, 1.05)
  assert.equal(read.confidence, 0.92)
  assert.equal(read.distribution.length, 3)
})

test('a score scale is anchors, and adding an anchor extends it without touching code', () => {
  const shape = {kind: 'score', levels: ['clearly manipulated', 'suspicious', 'probably organic', 'clearly organic']}
  assert.equal(SHAPES.score.accepts(3, shape), true)
  assert.equal(SHAPES.score.accepts(4, shape), false)
  assert.equal(SHAPES.score.accepts('organic', shape), false)
  // A scale is compared with tolerance, because it is a position and not a label.
  assert.equal(SHAPES.score.same(2.4, 2, 0.5), true)
  assert.equal(SHAPES.score.same(3, 2, 0.5), false)
})

test('a hosted choice reply is read into an answer, a confidence and the spread', () => {
  const shape = {kind: 'one-of', options: ['billing', 'technical', 'sales']}
  const read = outOfReply(
    {
      answers: {
        verdict: {
          type: 'choice',
          choice: 'billing',
          probabilities: {billing: 0.88, technical: 0.12, sales: 0.0},
          confidence: 0.81,
        },
      },
    },
    shape,
  )
  assert.equal(read.answer, 'billing')
  assert.equal(read.confidence, 0.81)
  assert.equal(read.distribution.length, 3)
  assert.equal(outOfReply({}, shape), null)
})

test('many independent questions about one thing go in ONE request, not one each', () => {
  const asking = {
    claimed: {question: 'does it claim without showing', shape: {kind: 'true-or-false'}},
    handed_back: {question: 'does it hand work back', shape: {kind: 'true-or-false'}},
    which_team: {question: 'who owns this', shape: {kind: 'one-of', options: ['billing', 'technical']}},
    how_bad: {question: 'how bad is it', shape: {kind: 'score', levels: ['fine', 'poor', 'awful']}},
  }
  const request = intoBatchRequest({content: 'the turn text', asking})
  // One state, four questions, one trip. The ids are the caller's own and the
  // answers come back under exactly those ids.
  assert.equal(request.state, 'the turn text')
  assert.deepEqual(Object.keys(request.questions), ['claimed', 'handed_back', 'which_team', 'how_bad'])
  assert.equal(request.questions.claimed.type, 'noul')
  assert.equal(request.questions.which_team.type, 'choice')
  assert.equal(request.questions.how_bad.type, 'score')

  const read = outOfBatchReply(
    {
      answers: {
        claimed: {type: 'noul', noul: 0.91},
        handed_back: {type: 'noul', noul: 0.04},
        which_team: {type: 'choice', choice: 'technical', probabilities: {billing: 0.1, technical: 0.9}, confidence: 0.88},
        how_bad: {type: 'score', score: 1.4, probabilities: {0: 0.1, 1: 0.5, 2: 0.4}, confidence: 0.6},
      },
    },
    asking,
  )
  assert.equal(read.claimed.answer, true)
  assert.equal(read.handed_back.answer, false)
  assert.equal(read.which_team.answer, 'technical')
  assert.equal(read.how_bad.answer, 1.4)
})

test('a JSON object wrapped in chatter is still read from a text model', () => {
  assert.deepEqual(readAnswer('Sure! Here you go:\n```json\n{"answer": true}\n```\nHope that helps'), {answer: true})
  assert.equal(readAnswer('no object here'), null)
  assert.equal(readAnswer(null), null)
})

test('no rubric, content or adapter named is a usage error, never an empty pass', async () => {
  await assert.rejects(() => run([]), /usage:/)
  await assert.rejects(() => run(['--rubric', '/nowhere/r.json']), /usage:/)
})
