#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs
//
// Purpose
//   Answer one declared question about some content with a fast classifier, and
//   only trust the answer if that classifier first got a set of held-out cases
//   right, cases whose verdicts were already known.
//
// The shape of an answer is DATA, not a branch
//   A classifier answers in one of three shapes: true or false, one of a named
//   set, or a score along a declared scale. The rubric says which. Nothing in
//   this file branches on a provider, and no provider name appears in it, so a
//   hosted classifier and a locally served model are the same thing here:
//   something that takes a question, a shape and some content, and returns an
//   answer with a confidence.
//
// Why calibration is not optional, and why speed makes it MORE important
//   A judge nobody scored agrees with everything. It emits confident output at
//   the same rate whether it understands the question or not, so adding it
//   makes a system feel checked while checking nothing. A cheap fast judge is
//   more dangerous than an expensive slow one, because it can be wrong about
//   ten thousand things before lunch. Being fast is not being right. So a
//   rubric with no calibration cases is REFUSED, and a classifier that fails
//   its cases is refused too, however cheap it was.
//
// Why the cases must disagree with each other
//   A rubric whose cases all expect the same answer is passed perfectly by a
//   classifier that always answers that way, which is the cheapest possible
//   wrong judge. So a rubric needs at least one case that must come out one way
//   and one that must come out another, and it is refused otherwise.
//
// Why confidence comes back rather than being swallowed
//   These classifiers return a probability, and throwing it away turns a
//   spectrum into a coin flip. The whole distribution comes back, not only the
//   winning answer, because "true at 0.95" and "true at 0.51" are different
//   facts that deserve different handling.
//
// Why the threshold is a set of bands and not one number
//   One threshold has two outcomes, act or do not act, which throws away the
//   most valuable thing a calibrated answer offers: knowing when to ask a
//   person. Bands are DATA on the rubric, so a question can say act above here,
//   send it to a human in the middle, ignore it below, and a different question
//   can draw those lines somewhere else without touching this file.
//
// Why oversized content is refused rather than trimmed
//   A classifier has a limit on how much it can read. Silently cutting the
//   content to fit produces a confident answer about a fragment, which is the
//   worst possible failure here, because it is indistinguishable from an answer
//   about the whole thing. So it refuses, and says to split the work up.
//
// Why every verdict is recorded with its probabilities
//   A judgement that leaves no trace cannot be gone looking for. Once something
//   has been acted on because a classifier said so, the only way to ever find
//   out the classifier was wrong about that class of thing is a record of what
//   it was asked, what it answered, and how sure it was. Without that, adding a
//   judge just adds a second opinion nobody can audit, which is worse than
//   having no judge, because it looks like oversight.
//
// Why a classifier is safer here than something that writes
//   Something that can only choose between options it was handed cannot invent
//   an answer that was never on the table. Its mistakes are bounded by the
//   option list, and a bounded mistake can have a guardrail built around it. A
//   model that writes prose can produce a confident sentence about a thing that
//   does not exist, and no threshold catches that.
//
// Non-negotiable invariants
//   - No model, product, vendor or person name appears in this file.
//   - It never invents or edits content. It chooses among what it was given.
//   - A refusal says what it would have needed. It never returns an answer it
//     did not obtain, and never falls back to a candidate that failed.
//   - Content that does not fit the classifier is refused, never trimmed.
//
// Usage
//   node ask-for-a-verdict.mjs --rubric <path> --content <path> --ask <module>
//     [--passes 2] [--sure-at 0.8]

import {readFile} from 'node:fs/promises'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {resolve, dirname} from 'node:path'
import {pathToFileURL} from 'node:url'

export class VerdictRefused extends Error {}

/**
 * An option is a name, and optionally a description of when it applies, which
 * is the difference between asking "which team" and telling the classifier that
 * the team is whoever must fix the root cause. That description changes the
 * answer, so it is DATA the rubric carries, never wording buried in a prompt.
 */
const readChoices = list =>
  (Array.isArray(list) ? list : []).map(one =>
    typeof one === 'string' ? {name: one, description: null} : {name: one?.name, description: one?.description ?? null},
  )

// Each shape says how to read an answer and what counts as the same answer.
// Adding a shape is a row here; nothing that consumes a verdict changes.
export const SHAPES = {
  'true-or-false': {
    choices: () => [{name: true, description: null}, {name: false, description: null}],
    valid: () => true,
    accepts: answer => typeof answer === 'boolean',
    describe: () => 'either true or false',
    same: (left, right) => left === right,
  },
  'one-of': {
    choices: shape => readChoices(shape.options),
    valid: shape => readChoices(shape.options).filter(one => typeof one.name === 'string').length >= 2,
    accepts: (answer, shape) => readChoices(shape.options).some(one => one.name === answer),
    describe: shape => `one of: ${readChoices(shape.options).map(one => one.name).join(', ')}`,
    same: (left, right) => left === right,
  },
  score: {
    // A scale is a list of anchors, and the index of the anchor is the score,
    // so adding an anchor extends the scale by one without touching anything.
    choices: shape => readChoices(shape.levels).map((one, index) => ({...one, name: index})),
    valid: shape => readChoices(shape.levels).length >= 2,
    accepts: (answer, shape) =>
      typeof answer === 'number' && answer >= 0 && answer <= readChoices(shape.levels).length - 1,
    describe: shape =>
      `a number from 0 to ${readChoices(shape.levels).length - 1}, where ` +
      readChoices(shape.levels).map((one, index) => `${index} is ${one.name}`).join(', '),
    // Scores are compared with a tolerance, because a scale is not a set of
    // labels and demanding an exact float would fail every honest classifier.
    same: (left, right, tolerance = 0.5) => Math.abs(left - right) <= tolerance,
  },
}

/**
 * Which band a confidence falls into. Bands are DATA because where to draw the
 * line between acting, asking a person and doing nothing is a property of the
 * decision, never of the classifier. Highest bar first, so the first one that
 * the confidence clears is the answer.
 */
export function bandFor(confidence, bands, whenUnknown = null) {
  if (!Array.isArray(bands) || bands.length === 0) return null
  // A classifier that returns a probability lands in a band. Something that
  // only returns an answer lands wherever the rubric says an unmeasured answer
  // belongs. Returning null here instead was a real defect: every band test
  // failed, so nothing was ever raised, and the check was perfectly green and
  // completely inert. An answer with no probability is still an answer, and
  // what to do with one is the rubric's call, not this function's.
  if (confidence === null || confidence === undefined) return whenUnknown
  const ordered = [...bands].sort((left, right) => right.at_least - left.at_least)
  return ordered.find(band => confidence >= band.at_least)?.then ?? ordered[ordered.length - 1]?.otherwise ?? null
}

export function checkRubric(rubric) {
  if (!rubric || typeof rubric.question !== 'string' || rubric.question.trim() === '') {
    throw new VerdictRefused('a rubric must carry a `question`, since that is the thing being asked')
  }
  const shape = rubric.answer_shape
  const kind = SHAPES[shape?.kind]
  if (!kind) {
    throw new VerdictRefused(
      `a rubric must declare an \`answer_shape.kind\`, one of: ${Object.keys(SHAPES).join(', ')}. ` +
        `Got ${JSON.stringify(shape?.kind ?? null)}`,
    )
  }
  if (!kind.valid(shape)) {
    throw new VerdictRefused(
      `answer_shape ${shape.kind} is not usable as written: ` +
        (shape.kind === 'one-of'
          ? 'it needs at least two `options`, because a menu of one is not a question'
          : 'it needs at least two `levels`, because a scale with one end is not a scale'),
    )
  }
  const cases = Array.isArray(rubric.calibration) ? rubric.calibration : []
  if (cases.length === 0) {
    throw new VerdictRefused(
      `rubric ${rubric.id ?? '(unnamed)'} has no calibration cases. A judge nobody scored agrees with ` +
        'everything, so it would make this system feel checked while checking nothing. Being fast and cheap ' +
        'makes that worse, not better, because it can be wrong about far more things. Add cases whose answers ' +
        'are already known.',
    )
  }
  for (const [index, one] of cases.entries()) {
    if (typeof one.content !== 'string') {
      throw new VerdictRefused(`calibration case ${index + 1} needs a \`content\` string`)
    }
    if (one.content_parts !== undefined && !Array.isArray(one.content_parts)) {
      throw new VerdictRefused(`calibration case ${index + 1} content_parts must be an array`)
    }
    if (!('expect' in one) || !kind.accepts(one.expect, shape)) {
      throw new VerdictRefused(
        `calibration case ${index + 1} expects ${JSON.stringify(one.expect ?? null)}, which is not ` +
          `${kind.describe(shape)}`,
      )
    }
  }
  const answers = new Set(cases.map(one => JSON.stringify(one.expect)))
  if (answers.size < 2) {
    throw new VerdictRefused(
      `every calibration case in rubric ${rubric.id ?? '(unnamed)'} expects the same answer, so a classifier ` +
        'that always answers that way passes all of them. Include at least one case that must come out ' +
        'differently.',
    )
  }
  return {
    question: rubric.question,
    shape,
    kind,
    cases,
    tolerance: rubric.score_tolerance,
    bands: Array.isArray(rubric.confidence_bands) ? rubric.confidence_bands : null,
    whenUnknown: rubric.band_when_confidence_unknown ?? null,
    // "confidence" (the default) or "agreement". A rubric whose classifier
    // answers well but cannot say how sure it is should gate on whether
    // repeated samples land the same way instead.
    bandsRead: rubric.bands_read ?? 'confidence',
    // How much of the calibration a candidate must get right. Every case, by
    // default, because for a yes/no question chance is one in two and anything
    // short of perfect lets a coin through. That same bar is wrong for a wide
    // choice: with nine options chance is one in nine, and demanding all of
    // them throws away a classifier that got twenty-six of twenty-seven. The
    // bar belongs to the question, so the question declares it.
    passWhen: typeof rubric.pass_when_share_correct === 'number' ? rubric.pass_when_share_correct : 1,
  }
}

/**
 * Content a classifier cannot read in one piece is refused. Trimming it to fit
 * would return a confident answer about a fragment, which reads exactly like an
 * answer about the whole thing, and nothing downstream could tell them apart.
 * The limit belongs to the candidate, because it is a fact about that
 * classifier, and it is declared rather than assumed.
 */
export function checkFits(content, candidate) {
  const limit = candidate?.accepts_characters
  if (typeof limit !== 'number' || content.length <= limit) return
  throw new VerdictRefused(
    `the content is ${content.length} characters and ${candidate.name} reads at most ${limit}. Trimming it would ` +
      'produce a confident answer about a fragment, indistinguishable from an answer about the whole thing. Split ' +
      'the content and ask about each part, then combine the answers.',
  )
}

/**
 * How one candidate does on the known cases. `errors` counts the times it did
 * not answer at all, which is a different fact from answering wrongly: the
 * first says fix the connection or the timeout, the second says do not use this
 * classifier for this question.
 */
export async function scoreCandidate({candidate, rubric, ask, passes}) {
  const {kind, shape, cases, tolerance, passWhen = 1} = rubric
  let correct = 0
  let errors = 0
  let firstError = null
  let asked = 0
  const attempts = cases.length * passes
  for (let round = 0; round < passes; round += 1) {
    for (const one of cases) {
      let given = null
      asked += 1
      try {
        given = await ask({candidate, question: rubric.question, shape, content: one.content, content_parts: one.content_parts})
      } catch (error) {
        // Keep a bounded, provider-safe cause. A failed connection or quota
        // must not be reported as a model that answered the cases wrongly.
        if (!firstError) {
          const message = String(error?.message ?? '')
          firstError = /^(?:the classifier answered \d{3}|classifier response had no usable answer:)/.test(message)
            ? message.slice(0, 240)
            // A timeout is a DOMException whose numeric `code` is 23, which
            // is how "no answer: 23" got into the log meaning "timed out".
            // Its name says so; a network error's code (ECONNREFUSED) does.
            : String(error?.cause?.code ?? (typeof error?.code === 'string' ? error.code : null) ?? error?.name ?? 'request failed').slice(0, 48)
        }
        given = null
      }
      if (given === null || given === undefined || !kind.accepts(given.answer, shape)) errors += 1
      else if (kind.same(given.answer, one.expect, tolerance)) correct += 1
    }
    // Once a case has gone wrong this candidate cannot pass, and every further
    // round is a paid call for an answer already decided.
    // Stop only when passing has become impossible, which with a bar under
    // 1 means enough cases are already lost that the rest cannot save it.
    if (attempts - (asked - correct) < Math.ceil(attempts * passWhen)) break
  }
  return {
    candidate: candidate?.name ?? String(candidate),
    correct,
    errors,
    first_error: firstError,
    attempts,
    // How many were actually put to it, which is NOT `attempts` once scoring
    // stops early. Reporting `correct` against the full total made a candidate
    // that got three of its first four look like it scored three out of eight,
    // and that number nearly threw away the best answer on the board.
    asked,
    stopped_early: asked < attempts,
    passed: correct >= Math.ceil(attempts * passWhen),
    needed: Math.ceil(attempts * passWhen),
  }
}

/** The first candidate that gets every case right, every time. Order is the caller's. */
/**
 * A key that changes whenever anything that could change the outcome changes:
 * the question, the cases, the labels, the bar, or who is available to ask.
 *
 * Not a content identity and never used as one. It exists only so a result can
 * be reused while its inputs are untouched, and being wrong about it costs one
 * unnecessary re-run rather than a wrong answer.
 */
export function calibrationKey(rubric, candidates, passes) {
  const material = JSON.stringify([
    rubric.question,
    rubric.cases,
    rubric.tolerance ?? null,
    rubric.passWhen ?? 1,
    candidates.map(one => one.name),
    passes,
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}-${material.length}`
}

/**
 * Pick a classifier that can actually answer this question.
 *
 * Calibration is the expensive part by a wide margin, and it used to run on
 * every single call. Measured: routing a request to its owner took 4.9
 * seconds, of which 27 calibration cases were 4.7 and the actual answer was
 * about 0.2. Every check in this package paid that, every time it fired, to
 * re-derive a result that had not changed.
 *
 * So the outcome is remembered against a key covering everything that could
 * change it. Teach the rubric a case, relabel one, move the bar, or offer a
 * different set of classifiers, and the key changes and calibration runs
 * again. Nothing is remembered across a change, which is the only property
 * that makes remembering safe here.
 */
const LOSSES_KEPT_MS = 6 * 60 * 60 * 1000

// Could not be reached, as opposed to measured. A candidate that answered too
// slowly WAS measured: it cannot answer inside a turn either, so its loss is
// real and is kept like any other.
const unreached = row => row.errors > 0 && row.first_error !== 'TimeoutError'

/** Refused because nothing has been calibrated for this rubric and set of judges yet. */
export class NotCalibratedYet extends VerdictRefused {}

export async function chooseCandidate({candidates, rubric, ask, passes, remember = null, calibrate = true}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new VerdictRefused('no candidate classifier was offered, so there is nothing that could answer')
  }

  const key = remember ? calibrationKey(rubric, candidates, passes) : null
  // A caller under a deadline of seconds only reads what calibration already
  // settled. Calibrating inside that deadline took over two minutes across the
  // local models, was cut off every time, saved nothing, and started again on
  // the next turn: 20,000 turns on 2026-09-26 without one verdict. Calibration
  // runs on its own (get-the-judges-ready.mjs) and this reads its result.
  if (!calibrate) {
    const known = key ? remember.get(key) : null
    const chosen = known?.chosen ? candidates.find(one => one.name === known.chosen) : null
    if (chosen) return {chosen, scoreboard: known.scoreboard ?? [], from_memory: true}
    if (known?.complete && Date.now() - Date.parse(known.at) < LOSSES_KEPT_MS) {
      throw new VerdictRefused(`no candidate answered every calibration case correctly: ${describeScoreboard(known.scoreboard ?? [])}`)
    }
    throw new NotCalibratedYet('this rubric has not been calibrated against the judges on offer yet')
  }
  // Scores of candidates that did NOT pass, kept for six hours. The caller
  // runs under a deadline measured in seconds, and one slow local model can
  // outlast it, so a calibration that only saved its result at the very end
  // never saved anything and started over on every fire (2026-09-26: the
  // before-a-call judge re-tested every Ollama model before every tool call).
  // Keeping each loss as it happens lets the next fire resume where this one
  // was cut off. The six hours are what let a model that was down, or a rubric that
  // nothing passes, be tried again without ever pinning an answer.
  let scoreboard = []
  if (remember && key) {
    const known = remember.get(key)
    if (known?.chosen) {
      const chosen = candidates.find(one => one.name === known.chosen)
      // A remembered name that is no longer on offer is not an answer.
      if (chosen) return {chosen, scoreboard: known.scoreboard ?? [], from_memory: true}
    } else if (known && Date.now() - Date.parse(known.at) < LOSSES_KEPT_MS) {
      // Only real losses are kept. A candidate that failed to ANSWER (a refused
      // connection, a busy server) was never measured, and skipping it for six
      // hours left a rubric uncalibrated behind a single dropped request.
      scoreboard = (known.scoreboard ?? []).filter(row => !row.passed && !unreached(row))
    }
  }

  for (const candidate of candidates) {
    if (scoreboard.some(row => row.candidate === (candidate?.name ?? String(candidate)))) continue
    const score = await scoreCandidate({candidate, rubric, ask, passes})
    scoreboard.push(score)
    if (!score.passed && remember && key) remember.set(key, {chosen: null, scoreboard})
    if (score.passed) {
      // A candidate ahead of this one that lost because it could not be
      // reached was never measured, so this choice holds only for this outage.
      // Remembering it pinned a rubric to a local server for good once the
      // hosted one was out of credit, and every later ask failed on a refused
      // connection after the local server stopped (2026-09-25).
      const outageDecided = scoreboard.some(row => row !== score && unreached(row))
      if (remember && key && !outageDecided) remember.set(key, {chosen: candidate.name, scoreboard})
      return {chosen: candidate, scoreboard}
    }
  }
  // Every candidate was measured and none passed. Kept as a finished result, so
  // callers stop asking for six hours instead of re-running the same losses,
  // unless a candidate could not be reached, which is an outage, not a result.
  if (remember && key && !scoreboard.some(unreached)) remember.set(key, {chosen: null, complete: true, scoreboard})
  throw new VerdictRefused(
    'no candidate answered every calibration case correctly, so nothing here has a verdict worth having on ' +
      'this question. Using one anyway would be inventing confidence rather than measuring it. Scoreboard: ' +
      describeScoreboard(scoreboard),
  )
}

function describeScoreboard(scoreboard) {
  return scoreboard
    .map(row => `${row.candidate} ${row.correct}/${row.attempts}${row.errors > 0 ? ` (${row.errors} no answer${row.first_error ? `: ${row.first_error}` : ''})` : ''}`)
    .join('; ')
}

/**
 * A place to keep calibration outcomes between runs, backed by one file.
 *
 * Reads and writes the whole file each time, which is right at this size and
 * keeps concurrent writers from ending up with half a record. A lost write
 * costs one re-calibration.
 */
export function rememberedIn(path) {
  if (!path) return null
  const readAll = () => {
    try {
      const held = JSON.parse(readFileSync(path, 'utf8'))
      return held && typeof held === 'object' ? held : {}
    } catch {
      return {}
    }
  }
  return {
    get: key => readAll()[key] ?? null,
    set: (key, value) => {
      try {
        const all = readAll()
        all[key] = {...value, at: new Date().toISOString()}
        mkdirSync(dirname(path), {recursive: true})
        writeFileSync(path, JSON.stringify(all, null, 2))
      } catch {
        // Failing to remember only costs the next run its calibration.
      }
    },
  }
}

export async function judge({
  rubric,
  content,
  content_parts = [],
  candidates,
  ask,
  passes = 2,
  sureAt = null,
  remember = null,
  calibrate = true,
  now = () => new Date(),
}) {
  const checked = checkRubric(rubric)
  if (!Array.isArray(content_parts)) throw new VerdictRefused('content_parts must be an array')
  const hasVision = content_parts.some(part => part?.kind === 'addressed-content' && part?.content_kind === 'vision')
  if (hasVision) {
    const visionCases = checked.cases.filter(one =>
      Array.isArray(one.content_parts) && one.content_parts.some(part => part?.kind === 'addressed-content' && part?.content_kind === 'vision'),
    )
    const visionAnswers = new Set(visionCases.map(one => JSON.stringify(one.expect)))
    if (visionAnswers.size < 2) {
      throw new VerdictRefused('screenshot review needs opposed calibration cases that each include addressed vision content')
    }
  }
  const {chosen, scoreboard} = await chooseCandidate({candidates, rubric: checked, ask, passes, remember, calibrate})
  checkFits(content, chosen)
  const given = await ask({candidate: chosen, question: checked.question, shape: checked.shape, content, content_parts})
  if (!given || !checked.kind.accepts(given.answer, checked.shape)) {
    throw new VerdictRefused(
      `${chosen?.name ?? chosen} passed calibration but then answered ${JSON.stringify(given?.answer ?? null)} ` +
        `for the real content, which is not ${checked.kind.describe(checked.shape)}`,
    )
  }
  const confidence = typeof given.confidence === 'number' ? given.confidence : null
  const agreement = typeof given.agreement === 'number' ? given.agreement : null
  // Which measurement the bands read is the rubric's to say, because the two
  // are different facts and on some questions only one of them is any good.
  //
  // Measured on the question of whether a call uses a name nobody read: the
  // best available classifier answered 12 out of 12 correctly and its
  // confidence on those same cases was 0.12, 0.26, 0.49 when true and 0.10,
  // 0.56, 0.59 when false. Completely overlapping. It knew the answer and had
  // no idea how sure it was, so no confidence line could be drawn and drawing
  // one anyway would have thrown away a reliable answer. Repeated sampling
  // landing the same way is a separate signal and it still worked.
  const reads = checked.bandsRead === 'agreement' ? agreement : confidence
  const band = bandFor(reads, checked.bands, checked.whenUnknown)
  return {
    rubric_id: rubric.id ?? null,
    asked_at: now().toISOString(),
    answered_by: chosen?.name ?? String(chosen),
    answer: given.answer,
    confidence,
    // How often repeated samples landed the same way. A separate fact from
    // confidence and never folded into it: a classifier can be consistently
    // unsure, or sure and unstable, and those call for different handling.
    agreement,
    // Which of the two the bands actually read, so a verdict can be understood
    // later without going back to the rubric to find out what gated it.
    band_read_from: checked.bandsRead,
    // The whole spread, not only the winner, because an answer at 0.51 and the
    // same answer at 0.98 call for different handling and nothing downstream
    // can tell them apart once the losing options have been thrown away.
    distribution: Array.isArray(given.distribution) ? given.distribution : null,
    // What the rubric says to DO at this confidence. Null means the rubric drew
    // no lines, which is a decision the caller then owns.
    band,
    // Reported rather than enforced: what counts as sure enough belongs to the
    // decision being made, never to the classifier.
    sure: sureAt === null || confidence === null ? null : confidence >= sureAt,
    sure_at: sureAt,
    // Enough to find out later that this judgement was wrong about this class
    // of thing. A verdict nobody can go back to is not oversight.
    asked_about: {characters: content.length, question: checked.question},
    calibration: {
      cases: checked.cases.length,
      passes_required: passes,
      candidates_tried: scoreboard.length,
      scoreboard,
    },
  }
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  if (!values.get('rubric') || !values.get('content') || !values.get('ask')) {
    throw new VerdictRefused(
      'usage: ask-for-a-verdict.mjs --rubric <path> --content <path> --ask <module> [--passes 2] [--sure-at 0.8]. ' +
        'The --ask module is the adapter that reaches a classifier; it exports `ask` and `candidates`.',
    )
  }
  return {
    rubric: resolve(values.get('rubric')),
    content: resolve(values.get('content')),
    askModule: resolve(values.get('ask')),
    passes: Number(values.get('passes') || 2),
    sureAt: values.get('sure-at') === undefined ? null : Number(values.get('sure-at')),
  }
}

export async function run(argv, injected = {}) {
  const {rubric: rubricPath, content: contentPath, askModule, passes, sureAt} = readArguments(argv)
  const adapter = injected.adapter ?? (await import(pathToFileURL(askModule).href))
  if (typeof adapter.ask !== 'function' || typeof adapter.candidates !== 'function') {
    throw new VerdictRefused(`${askModule} must export \`ask\` and \`candidates\``)
  }
  return judge({
    rubric: JSON.parse(await readFile(rubricPath, 'utf8')),
    content: await readFile(contentPath, 'utf8'),
    candidates: await adapter.candidates(),
    ask: adapter.ask,
    passes,
    sureAt,
  })
}
