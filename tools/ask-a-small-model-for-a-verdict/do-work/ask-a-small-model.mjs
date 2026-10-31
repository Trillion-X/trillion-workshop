// One JSON request on standard input, one action named on the command line:
//
//   ask                      ask one declared question about some content
//   route                    pick which of the person's owners holds an answer
//   scoreboard               score every model on offer against every rubric
//   calibrate                score and keep the result so asking later is fast
//   find-lines               measure where a rubric's confidence line belongs
//   record-wrong             add a wrong verdict to a rubric as a known case
//   note-repeat              file a flagged text under an earlier one, or as new
//   answer-state-questions   answer typed questions about a state in one request
//
// The last line printed is { result } or { error } saying what to change.
// Rubrics, owners and provider rows are the person's own files and inputs; no
// provider, model, threshold or word list is in this code.

import {appendFileSync, readFileSync, writeFileSync} from 'node:fs'
import {VerdictRefused, checkRubric, chooseCandidate, rememberedIn} from './ask-for-a-verdict.mjs'
import {judgeContent} from './judge-content.mjs'
import {classifiersFrom, whoCanBeAsked} from './who-can-be-asked.mjs'
import {readSettings as readRouteSettings, route} from './route-to-the-owner-that-answers.mjs'
import {scoreboard} from './see-which-models-can-judge.mjs'
import {findLines} from './find-where-the-line-should-go.mjs'
import {addCase, asExpected, lastVerdictFor} from './tell-it-when-it-was-wrong.mjs'
import {noteIt, readCharacters, readMatching, readMemory, shapesFor, whichShape, writeMemory} from './remember-what-was-already-said.mjs'
import {answerStateQuestions} from './answer-state-questions.mjs'

const need = (request, field, what) => {
  if (request[field] === undefined || request[field] === null || request[field] === '') {
    throw new VerdictRefused(`${field} is required: ${what}`)
  }
  return request[field]
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new VerdictRefused(`${what} could not be read as JSON at ${path}`)
  }
}

/**
 * A rubrics file is { providers?: [...], rubrics: [...] }. A request may carry
 * its own providers; otherwise the file's are used.
 */
function rubricsFile(request) {
  const path = need(request, 'rubrics_file', 'the path of your rubrics file ({providers?, rubrics: [...]})')
  const file = readJson(path, 'the rubrics file')
  if (!Array.isArray(file.rubrics)) throw new VerdictRefused('the rubrics file must hold a rubrics list')
  return {path, file, providers: request.providers ?? file.providers}
}

const oneRubric = (file, id) => {
  const found = file.rubrics.find(one => one.id === id)
  if (!found) throw new VerdictRefused(`no rubric called ${id} in the rubrics file`)
  return found
}

const ACTIONS = {
  async ask(request) {
    const excerptCharacters = request.log_file ? readCharacters(request.excerpt_characters, 'excerpt_characters') : 0
    const rubric = request.rubric ?? (() => {
      const {file} = rubricsFile(request)
      return oneRubric(file, need(request, 'rubric_id', 'which rubric in the file to ask'))
    })()
    const providers = request.providers ?? (request.rubrics_file ? rubricsFile(request).providers : undefined)
    const verdict = await judgeContent({
      rubric,
      content: request.content,
      content_parts: request.content_parts,
      providers,
      passes: request.passes ?? 2,
      sureAt: request.sure_at ?? null,
      remember: rememberedIn(request.remember_file),
      calibrate: request.calibrate !== false,
    })
    // A verdict nobody can go back to is not oversight: with a log_file the
    // verdict is kept with an excerpt of what it looked at, which is what
    // record-wrong learns from.
    if (request.log_file) {
      const kept = {...verdict, asked_about: {...verdict.asked_about, excerpt: request.content.slice(0, excerptCharacters)}}
      appendFileSync(request.log_file, `${JSON.stringify(kept)}\n`)
    }
    return verdict
  },

  async route(request) {
    const owners = need(request, 'owners', 'the places an answer could live: [{id, holds, ask?, for_example?: [...]}]')
    const lookingFor = need(request, 'looking_for', 'what is being looked for')
    const settings = readRouteSettings(request)
    const {candidates, ask} = await classifiersFrom({ask_in_order: request.providers})
    if (candidates.length === 0) throw new VerdictRefused('nothing is available to ask, so nothing was routed')
    return route({
      owners,
      lookingFor,
      settings,
      candidates,
      ask,
      remember: rememberedIn(request.remember_file),
    })
  },

  async scoreboard(request) {
    const {file, providers} = rubricsFile(request)
    const asking = await whoCanBeAsked({ask_in_order: providers}, {phase: 'calibration'})
    if (asking.length === 0) throw new VerdictRefused('nothing is available to ask')
    return scoreboard({rubrics: file.rubrics, asking, passes: request.passes ?? 2})
  },

  async calibrate(request) {
    const {file, providers} = rubricsFile(request)
    const remember = rememberedIn(need(request, 'remember_file', 'where to keep what calibration settles'))
    const {candidates, ask} = await classifiersFrom({ask_in_order: providers}, {phase: 'calibration'})
    const outcomes = []
    for (const rubric of file.rubrics) {
      const started = Date.now()
      try {
        const {chosen, scoreboard: board} = await chooseCandidate({candidates, rubric: checkRubric(rubric), ask, passes: request.passes ?? 1, remember})
        outcomes.push({rubric: rubric.id, chosen: chosen.name, scoreboard: board, took_ms: Date.now() - started})
      } catch (error) {
        outcomes.push({rubric: rubric.id, refused: error.message})
      }
    }
    return {outcomes}
  },

  async 'find-lines'(request) {
    const {file, providers} = rubricsFile(request)
    const {candidates, ask} = await classifiersFrom({ask_in_order: providers})
    if (candidates.length === 0) throw new VerdictRefused('nothing is available to ask, so no line can be measured')
    const wanted = file.rubrics.filter(one => request.rubric_id === undefined || one.id === request.rubric_id)
    return {lines: await findLines({rubrics: wanted, candidates, ask, band: request.band ?? null})}
  },

  async 'record-wrong'(request) {
    const {path, file} = rubricsFile(request)
    const rubric = oneRubric(file, need(request, 'rubric_id', 'which rubric the verdict was for'))
    if (request.should_have_been === undefined) throw new VerdictRefused('should_have_been is required: the answer it should have given')
    let content = request.about
    if (!content) {
      const found = request.log_file ? lastVerdictFor(request.log_file, rubric.id) : null
      if (!found) {
        throw new VerdictRefused(`nothing to learn from: give the text in about, or a log_file with a verdict for ${rubric.id} that kept what it looked at`)
      }
      content = found.asked_about.excerpt
    }
    const result = addCase(rubric, content, asExpected(request.should_have_been), request.because)
    writeFileSync(path, JSON.stringify(file, null, 2))
    return {
      rubric: rubric.id,
      outcome: result.why,
      cases_now: rubric.calibration.length,
      what_happens_next: 'candidates are scored against all the cases on the next calibration, so one that cannot handle this stops being chosen for this question; run scoreboard to see who still passes and find-lines because the threshold may have moved',
    }
  },

  async 'note-repeat'(request) {
    const memory = readMemory(need(request, 'memory_file', 'where the flagged shapes are kept'))
    const rubricId = need(request, 'rubric_id', 'which question this was flagged under')
    const excerpt = need(request, 'excerpt', 'the flagged text')
    const keepCharacters = readCharacters(request.keep_characters, 'keep_characters')
    const known = shapesFor(memory, rubricId)
    let shapeId = null
    if (known.length > 0) {
      // Without providers only near-identical texts are recognised as repeats;
      // anything else is counted as new, which overcounts shapes rather than
      // inflating a repeat count.
      const matching = readMatching(request, {asking: Boolean(request.providers)})
      const {candidates, ask} = request.providers ? await classifiersFrom({ask_in_order: request.providers}) : {candidates: [], ask: null}
      shapeId = await whichShape({excerpt, shapes: known, matching, candidates, ask})
    }
    const shape = noteIt({memory, rubricId, excerpt, keepCharacters, shapeId, session: request.session, at: new Date().toISOString()})
    writeMemory(request.memory_file, memory)
    return {shape: shape.id, times: shape.times, sessions: shape.sessions.length, first_seen: shape.first_seen, repeat: shape.times > 1}
  },

  async 'answer-state-questions'(request) {
    return answerStateQuestions(request)
  },
}

const action = process.argv[2]
try {
  if (!Object.hasOwn(ACTIONS, action)) throw new VerdictRefused(`the action must be one of: ${Object.keys(ACTIONS).join(', ')}`)
  const request = JSON.parse(readFileSync(0, 'utf8'))
  console.log(JSON.stringify({result: await ACTIONS[action](request)}))
} catch (error) {
  console.log(JSON.stringify({error: error instanceof SyntaxError ? 'the request must be one JSON object on standard input' : error.message}))
  process.exitCode = 1
}
