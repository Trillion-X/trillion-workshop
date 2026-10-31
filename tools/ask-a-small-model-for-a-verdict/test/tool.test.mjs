// The tool as a person's AI runs it: one JSON request on standard input, one
// action on the command line, { result } or { error } on the last line. The
// "model server" is a small in-process stand-in that speaks the chat endpoint;
// the data is a made-up bakery.
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

const entry = new URL('../do-work/ask-a-small-model.mjs', import.meta.url).pathname

// answers(system, user, format) -> the JSON object the stand-in model replies with
async function withServer(answers, body) {
  const asked = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/tags') return response.end(JSON.stringify({models: [{name: 'stand-in', size: 1}]}))
      const sent = JSON.parse(Buffer.concat(chunks).toString())
      const [system, user] = sent.messages
      asked.push(user?.content ?? system.content)
      response.end(JSON.stringify({message: {content: JSON.stringify(answers(system.content, user?.content ?? '', sent.format))}}))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(`http://127.0.0.1:${server.address().port}`, asked)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

function run(action, request) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [entry, action], (error, stdout) => {
      const last = stdout.trim().split('\n').pop()
      resolve({code: error?.code ?? 0, ...JSON.parse(last)})
    })
    child.stdin.end(JSON.stringify(request))
  })
}

const scratch = () => mkdtempSync(join(tmpdir(), 'small-model-'))

// A provider row always names where the server is and how long a request may take.
const local = (endpoint, more = {}) => ({via: 'locally-served', endpoint, timeout_seconds: 30, ...more})

// The bars a route needs from the person, written out in the request.
const routeBars = {
  pass_when_share_correct: 0.9,
  confidence_bands: [{at_least: 0.6, then: 'go-there'}, {at_least: 0, then: 'look-in-the-top-two'}],
  band_when_confidence_unknown: 'look-in-the-top-two',
}

const claimsRubric = {
  id: 'claims-done',
  question: 'Does the note say the order is ready without saying it was checked?',
  answer_shape: {kind: 'true-or-false'},
  accept_when_answer_in: [true],
  calibration: [
    {content: 'the sourdough order is ready, trust me', expect: true},
    {content: 'counted 12 loaves against the slip: ready', expect: false},
  ],
}
const honest = (_system, user) => ({answer: user.includes('trust me')})

test('ask: a model that read the cases answers, the verdict is accepted, kept in a log and the calibration is remembered', async () => {
  const dir = scratch()
  await withServer(honest, async (endpoint, asked) => {
    const request = {
      rubric: claimsRubric,
      content: 'the rye order is ready, trust me',
      providers: [local(endpoint)],
      remember_file: join(dir, 'kept.json'),
      log_file: join(dir, 'verdicts.jsonl'),
      excerpt_characters: 600,
    }
    const first = await run('ask', request)
    assert.equal(first.result.answer, true)
    assert.equal(first.result.accepted, true)
    assert.equal(first.result.answered_by, 'stand-in')
    assert.equal(JSON.parse(readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').trim()).asked_about.excerpt, request.content)
    // Asked again, the kept calibration is read: only the question itself is put to the model.
    const before = asked.length
    const second = await run('ask', request)
    assert.equal(second.result.answer, true)
    assert.equal(asked.length - before, 1)
  })
})

test('ask: a model that says yes to everything is refused, never accepted as a judge', async () => {
  await withServer(() => ({answer: true}), async endpoint => {
    const refused = await run('ask', {rubric: claimsRubric, content: 'anything', providers: [local(endpoint)]})
    assert.equal(refused.code, 1)
    assert.match(refused.error, /no candidate answered every calibration case correctly/)
  })
})

test('ask: no provider rows and no rubric gate are refused with what to add', async () => {
  const noProviders = await run('ask', {rubric: claimsRubric, content: 'x'})
  assert.match(noProviders.error, /provider row is required/)
  const noGate = await run('ask', {rubric: {...claimsRubric, accept_when_answer_in: []}, content: 'x', providers: [local('http://127.0.0.1:9')]})
  assert.match(noGate.error, /accept_when_answer_in/)
})

test('route: the owner whose examples match is picked, with how to ask it and the others to try', async () => {
  const owners = [
    {id: 'oven-log', holds: 'what was baked and when', ask: 'read the oven log', for_example: ['when did the rye come out', 'how many loaves did the oven take']},
    {id: 'supplier-book', holds: 'who sells flour and at what price', ask: 'open the supplier book', for_example: ['who sells the cheapest flour', 'what does a sack of flour cost']},
  ]
  const choosing = (system, user, format) => {
    const options = format.properties.answer.enum
    return {answer: /flour|cost|sells/.test(user) ? options[1] : options[0]}
  }
  await withServer(choosing, async endpoint => {
    const routed = await run('route', {...routeBars, owners, looking_for: 'who sells flour near the shop', providers: [local(endpoint)]})
    assert.equal(routed.result.go_to, 'supplier-book')
    assert.equal(routed.result.how, 'open the supplier book')
    assert.equal(routed.result.what_to_do, 'look-in-the-top-two')
  })
})

test('route: the bar and the bands are the person\'s, and a request without them is refused before anything is asked', async () => {
  const owners = [{id: 'a', holds: 'one', for_example: ['x']}, {id: 'b', holds: 'two', for_example: ['y']}]
  const base = {owners, looking_for: 'z', providers: [local('http://127.0.0.1:9')]}
  assert.match((await run('route', base)).error, /pass_when_share_correct is required/)
  assert.match((await run('route', {...base, ...routeBars, pass_when_share_correct: 1.5})).error, /pass_when_share_correct is required/)
  assert.match((await run('route', {...base, ...routeBars, confidence_bands: []})).error, /confidence_bands is required/)
  assert.match((await run('route', {...base, ...routeBars, band_when_confidence_unknown: ''})).error, /band_when_confidence_unknown is required/)
})

test('route: the share the person sets decides whether a model with one mis-filed example is used', async () => {
  const owners = [
    {id: 'oven-log', holds: 'what was baked', for_example: ['when did the rye come out', 'how many loaves went in', 'which tray ran hot', 'what time was the bake']},
    {id: 'supplier-book', holds: 'who sells flour', for_example: ['who sells flour', 'what does a sack cost', 'which mill delivers', 'when does the mill ship']},
  ]
  // Files seven of eight examples right: the "which tray ran hot" example is sent to the supplier book.
  const slipping = (_system, user, format) => {
    const options = format.properties.answer.enum
    return {answer: /flour|sack|mill|tray/.test(user) ? options[1] : options[0]}
  }
  await withServer(slipping, async endpoint => {
    const request = {...routeBars, owners, looking_for: 'who sells flour', providers: [local(endpoint)]}
    const lenient = await run('route', {...request, pass_when_share_correct: 0.8})
    assert.equal(lenient.result.go_to, 'supplier-book')
    const strict = await run('route', {...request, pass_when_share_correct: 1})
    assert.match(strict.error, /no candidate answered/)
  })
})

test('scoreboard and calibrate: every model is scored per rubric and the settled choice is kept', async () => {
  const dir = scratch()
  const rubrics = join(dir, 'rubrics.json')
  await withServer(honest, async endpoint => {
    writeFileSync(rubrics, JSON.stringify({providers: [local(endpoint)], rubrics: [claimsRubric]}))
    const board = await run('scoreboard', {rubrics_file: rubrics, passes: 1})
    assert.equal(board.result[0].rows[0].verdict, 'can judge this')
    assert.equal(board.result[0].rows[0].correct, 2)
    const kept = await run('calibrate', {rubrics_file: rubrics, remember_file: join(dir, 'kept.json')})
    assert.equal(kept.result.outcomes[0].chosen, 'stand-in')
    assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, 'kept.json'), 'utf8'))).length, 1)
  })
})

test('record-wrong: a wrong verdict becomes a known case in the rubric, once', async () => {
  const dir = scratch()
  const rubrics = join(dir, 'rubrics.json')
  writeFileSync(rubrics, JSON.stringify({rubrics: [claimsRubric]}))
  const request = {rubrics_file: rubrics, rubric_id: 'claims-done', should_have_been: 'false', about: 'rye ready, checked twice', because: 'it says it was checked'}
  const added = await run('record-wrong', request)
  assert.equal(added.result.outcome, 'added')
  assert.equal(added.result.cases_now, 3)
  const again = await run('record-wrong', request)
  assert.match(again.result.outcome, /already there/)
  assert.equal(JSON.parse(readFileSync(rubrics, 'utf8')).rubrics[0].calibration[2].expect, false)
  const nothing = await run('record-wrong', {rubrics_file: rubrics, rubric_id: 'claims-done', should_have_been: 'true'})
  assert.match(nothing.error, /nothing to learn from/)
})

test('find-lines: with a model that gives no confidence it says so instead of drawing a line', async () => {
  const dir = scratch()
  const rubrics = join(dir, 'rubrics.json')
  await withServer(honest, async endpoint => {
    writeFileSync(rubrics, JSON.stringify({providers: [local(endpoint)], rubrics: [claimsRubric]}))
    const lines = await run('find-lines', {rubrics_file: rubrics})
    assert.match(lines.result.lines[0].cannot, /one-sided/)
  })
})

test('note-repeat: the same text again is counted as a repeat, a different one is new', async () => {
  const memory = join(scratch(), 'shapes.json')
  const text = 'the sourdough order is ready, trust me, nothing was counted'
  const bars = {keep_characters: 600, plainly_the_same_at: 0.8}
  const one = await run('note-repeat', {...bars, memory_file: memory, rubric_id: 'claims-done', excerpt: text, session: 'monday'})
  assert.deepEqual([one.result.times, one.result.repeat], [1, false])
  const two = await run('note-repeat', {...bars, memory_file: memory, rubric_id: 'claims-done', excerpt: text, session: 'tuesday'})
  assert.deepEqual([two.result.times, two.result.sessions, two.result.repeat], [2, 2, true])
  const other = await run('note-repeat', {...bars, memory_file: memory, rubric_id: 'claims-done', excerpt: 'oven temperature never written down'})
  assert.equal(other.result.times, 1)
})

test('note-repeat: how much text is kept and where plainly-the-same starts are the person\'s numbers', async () => {
  const memory = join(scratch(), 'shapes.json')
  const text = 'the sourdough order is ready, trust me, nothing was counted'
  const missing = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: text})
  assert.match(missing.error, /keep_characters is required/)
  const first = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: text, keep_characters: 20})
  assert.equal(first.result.times, 1)
  assert.equal(JSON.parse(readFileSync(memory, 'utf8')).shapes[0].example, text.slice(0, 20))
  // There is a remembered shape now, so the overlap bar is needed to decide whether the next text repeats it.
  const noBar = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: text, keep_characters: 20})
  assert.match(noBar.error, /plainly_the_same_at is required/)
  const stored = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: 'the sourdough order is ready', keep_characters: 100, plainly_the_same_at: 1})
  assert.equal(stored.result.times, 1)
  // 'the sourdough order is late' shares four of six distinct words with the stored text (overlap 0.67):
  // the same at a bar of 0.5, a new kind at a bar of 0.9.
  const loose = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: 'the sourdough order is late', keep_characters: 100, plainly_the_same_at: 0.5})
  assert.equal(loose.result.repeat, true)
  const strict = await run('note-repeat', {memory_file: memory, rubric_id: 'claims-done', excerpt: 'the sourdough order is waiting', keep_characters: 100, plainly_the_same_at: 0.9})
  assert.equal(strict.result.repeat, false)
})

test('note-repeat with a model needs the person\'s two model bars, and uses them', async () => {
  const memory = join(scratch(), 'shapes.json')
  const bars = {keep_characters: 600, plainly_the_same_at: 1}
  await run('note-repeat', {...bars, memory_file: memory, rubric_id: 'claims-done', excerpt: 'ready, trust me'})
  await withServer(() => ({answer: 'claims-done-1'}), async endpoint => {
    const asking = {...bars, memory_file: memory, rubric_id: 'claims-done', excerpt: 'ready without a count', providers: [local(endpoint)]}
    assert.match((await run('note-repeat', asking)).error, /pass_when_share_correct is required/)
    assert.match((await run('note-repeat', {...asking, pass_when_share_correct: 0.8})).error, /same_at_least is required/)
  })
})

test('ask: with a log_file the person says how much of the text is kept', async () => {
  const dir = scratch()
  await withServer(honest, async endpoint => {
    const asking = {rubric: claimsRubric, content: 'the rye order is ready, trust me', providers: [local(endpoint)], log_file: join(dir, 'verdicts.jsonl')}
    assert.match((await run('ask', asking)).error, /excerpt_characters is required/)
    const kept = await run('ask', {...asking, excerpt_characters: 9})
    assert.equal(kept.result.answer, true)
    assert.equal(JSON.parse(readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').trim()).asked_about.excerpt, 'the rye o')
  })
})

test('ask: a provider row that leaves out its address or time limit is refused, naming the field', async () => {
  const base = {rubric: claimsRubric, content: 'x'}
  assert.match((await run('ask', {...base, providers: [{via: 'locally-served', timeout_seconds: 3}]})).error, /provider row 1 \(locally-served\) needs endpoint/)
  assert.match((await run('ask', {...base, providers: [{via: 'locally-served', endpoint: 'http://127.0.0.1:9'}]})).error, /provider row 1 \(locally-served\) needs timeout_seconds/)
  assert.match((await run('ask', {...base, providers: [{via: 'hosted-classifier', endpoint: 'https://x', model: 'm', needs_no_key: true}]})).error, /provider row 1 \(hosted-classifier\) needs samples/)
})

test('ask: a row that declares accepts_characters refuses longer content, and one that does not is sent it whole', async () => {
  await withServer(honest, async (endpoint, asked) => {
    const content = 'the rye order is ready, trust me, and the long note goes on past the limit'
    const limited = await run('ask', {rubric: claimsRubric, content, providers: [local(endpoint, {accepts_characters: 30})]})
    assert.match(limited.error, /reads at most 30/)
    const unlimited = await run('ask', {rubric: claimsRubric, content, providers: [local(endpoint)]})
    assert.equal(unlimited.result.answer, true)
    assert.ok(asked.includes(content))
  })
})

test('answer-state-questions: every question comes back in its type, and a reply missing one is refused', async () => {
  const questions = {
    urgent: {type: 'noul', instructions: 'Is the order late?'},
    kind: {type: 'choice', instructions: 'Which loaf?', criteria: {rye: 'dark', white: 'light'}},
    rush: {type: 'score', instructions: 'How rushed, 0 to 5?'},
  }
  await withServer((prompt, _user, format) => {
    assert.deepEqual(format.required, ['urgent', 'kind', 'rush'])
    assert.deepEqual(format.properties.kind.enum, ['rye', 'white'])
    assert.match(prompt, /Is the order late\?/)
    assert.match(prompt, /"customer": "table 4"/)
    return {urgent: 0.9, kind: 'rye', rush: 3}
  }, async endpoint => {
    const answered = await run('answer-state-questions', {state: {customer: 'table 4'}, questions, endpoint, model: 'stand-in', timeout_seconds: 30})
    assert.deepEqual(answered.result.answers, {urgent: 0.9, kind: 'rye', rush: 3})
  })
  await withServer(() => ({urgent: 0.9, kind: 'rye'}), async endpoint => {
    const refused = await run('answer-state-questions', {state: 'x', questions, endpoint, model: 'stand-in', timeout_seconds: 30})
    assert.match(refused.error, /answer to question rush is missing/)
  })
  await withServer(() => ({urgent: 7, kind: 'rye', rush: 3}), async endpoint => {
    const refused = await run('answer-state-questions', {state: 'x', questions, endpoint, model: 'stand-in', timeout_seconds: 30})
    assert.match(refused.error, /question urgent is not a number from 0 to 1/)
  })
})

test('an unknown action or a bad request says what to change', async () => {
  assert.match((await run('guess', {})).error, /the action must be one of/)
  assert.match((await run('answer-state-questions', {})).error, /state is required/)
})
