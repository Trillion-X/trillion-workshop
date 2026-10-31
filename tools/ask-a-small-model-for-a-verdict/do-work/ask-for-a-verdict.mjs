#!/usr/bin/env node
// tools/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs
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
import {readFileSync, writeFileSync, mkdirSync, readdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, lstatSync, fstatSync, readSync, constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {resolve, dirname, relative, sep} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {blake3} from '@noble/hashes/blake3.js'

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
  // A choice can stand for a yes or no: `yes_when` names the options that mean
  // yes. A small classifier picks among described situations far better than
  // it answers a bare yes/no about code (one small model: 15 of 15 choosing where
  // JSON.stringify output goes, 9 of 15 asked yes/no), and the cases then
  // expect true or false, so a case need not guess which "no" option applies.
  'one-of': {
    choices: shape => readChoices(shape.options),
    valid: shape => readChoices(shape.options).filter(one => typeof one.name === 'string').length >= 2
      && (shape.yes_when === undefined || (Array.isArray(shape.yes_when) && shape.yes_when.length > 0
        && shape.yes_when.every(name => readChoices(shape.options).some(one => one.name === name)))),
    accepts: (answer, shape) => readChoices(shape.options).some(one => one.name === answer)
      || (Array.isArray(shape.yes_when) && typeof answer === 'boolean'),
    describe: shape => `one of: ${readChoices(shape.options).map(one => one.name).join(', ')}` +
      (Array.isArray(shape.yes_when) ? `, or true or false (true when ${shape.yes_when.join(' or ')})` : ''),
    same: (left, right, tolerance, shape) => (typeof right === 'boolean' && Array.isArray(shape?.yes_when)
      ? answerMeansYes(shape, left) === right : left === right),
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
    same: (left, right, tolerance) => Math.abs(left - right) <= tolerance,
  },
}

/**
 * Which band a confidence falls into. Bands are DATA because where to draw the
 * line between acting, asking a person and doing nothing is a property of the
 * decision, never of the classifier. Highest bar first, so the first one that
 * the confidence clears is the answer.
 */
/** Whether an answer means yes: true itself, or a choice the shape's `yes_when` names. */
export const answerMeansYes = (shape, answer) => (Array.isArray(shape?.yes_when) ? shape.yes_when.includes(answer) : answer === true)

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
  // Calibration cannot repair an invocation that cannot observe the claimed fact.
  // Keep that limitation explicit instead of qualifying a proxy on assistant assertions.
  if (rubric.unavailable_context !== undefined) {
    throw new VerdictRefused(`required observable context is unavailable: ${String(rubric.unavailable_context).slice(0, 600)}`)
  }
  // The caller reads the context a rubric names; this file only keys calibration by which reader it was.
  if (rubric.context_reader !== undefined && (typeof rubric.context_reader !== 'string' || rubric.context_reader === ''))
    throw new VerdictRefused('context_reader must name the reader that supplies the rubric\'s context')
  for (const field of ['reads_characters', 'request_context_characters'])
    if (rubric[field] !== undefined && (!Number.isSafeInteger(rubric[field]) || rubric[field] <= 0))
      throw new VerdictRefused(`${field} must be a positive safe integer`)
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
  if (shape.kind === 'score' && !(typeof rubric.score_tolerance === 'number' && Number.isFinite(rubric.score_tolerance)
      && rubric.score_tolerance >= 0)) {
    throw new VerdictRefused(
      `rubric ${rubric.id ?? '(unnamed)'} needs \`score_tolerance\`: how far, in levels, an answer may be from the ` +
        'expected one and still count as right. A scale is not a set of exact matches, and how close is close ' +
        'enough is the rubric\'s call, so nothing is assumed.',
    )
  }
  const cases = Array.isArray(rubric.calibration) ? rubric.calibration : []
  if (rubric.max_age_hours !== undefined &&
      (typeof rubric.max_age_hours !== 'number' || !Number.isFinite(rubric.max_age_hours) || rubric.max_age_hours <= 0)) {
    throw new VerdictRefused('max_age_hours must be a positive finite number')
  }
  if (rubric.pass_when_share_correct !== undefined &&
      (typeof rubric.pass_when_share_correct !== 'number' || !Number.isFinite(rubric.pass_when_share_correct) ||
       rubric.pass_when_share_correct <= 0 || rubric.pass_when_share_correct > 1)) {
    throw new VerdictRefused('pass_when_share_correct must be a finite number greater than zero and at most one')
  }
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
  const response = rubric.after_recorded_correction
  const basePassWhen = rubric.pass_when_share_correct ?? 1
  const baseMaxAge = rubric.max_age_hours ?? 24
  if (response !== undefined && (!response || typeof response !== 'object' || Array.isArray(response)
      || typeof response.pass_when_share_correct !== 'number' || !Number.isFinite(response.pass_when_share_correct)
      || response.pass_when_share_correct < basePassWhen || response.pass_when_share_correct > 1
      || typeof response.max_age_hours !== 'number' || !Number.isFinite(response.max_age_hours)
      || response.max_age_hours <= 0 || response.max_age_hours > baseMaxAge))
    throw new VerdictRefused('after_recorded_correction must retain or tighten the pass share and qualification age')
  // Recorded corrections are source-attributed learning records, not held-out scores.
  // Only the declared stricter policy applies; passing again never silently removes it.
  const corrections = cases.reduce((sum, one) => sum + (one.correction ? 1 : 0) + (one.label_history?.length ?? 0), 0)
  const adaptiveReview = response && corrections > 0 ? {state: 'tightened-after-recorded-correction',
    recorded_corrections: corrections, pass_when_share_correct: response.pass_when_share_correct,
    max_age_hours: response.max_age_hours} : null
  return {
    id: rubric.id ?? null,
    question: rubric.question,
    shape,
    kind,
    cases,
    tolerance: rubric.score_tolerance,
    maxAgeHours: adaptiveReview?.max_age_hours ?? baseMaxAge,
    adaptiveReview,
    inputPolicy: {context_reader: rubric.context_reader ?? null, definition_schema_contract: rubric.definition_schema_contract ?? null, definition_receipt_calibration: rubric.definition_receipt_calibration ?? null, reads_characters: rubric.reads_characters ?? null,
      request_context_characters: rubric.request_context_characters ?? null},
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
    passWhen: adaptiveReview?.pass_when_share_correct ?? basePassWhen,
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
  checkPasses(passes)
  const {kind, shape, cases, tolerance, passWhen = 1} = rubric
  let correct = 0
  let errors = 0
  let firstError = null
  let asked = 0
  const attempts = cases.length * passes
  if (candidate?.identity_required && !candidate.identity) return {candidate: candidate.name, correct: 0, errors: 0,
    first_error: 'required_model_identity_unavailable', attempts, asked: 0, stopped_early: true, passed: false,
    unmeasured: true, needed: Math.ceil(attempts * passWhen)}
  let identityDrift = false
  calibration: for (let round = 0; round < passes; round += 1) {
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
      if (given !== null && given !== undefined && (candidate?.identity_required && given.answered_by_identity !== candidate.identity
          || given.answered_by_identity !== undefined && candidate?.identity && given.answered_by_identity !== candidate.identity)) {
        errors += 1; firstError = given?.answered_by_identity ? 'served_identity_changed' : 'served_identity_unavailable'; identityDrift = true
        break calibration
      }
      if (given === null || given === undefined || !kind.accepts(given.answer, shape)) errors += 1
      else if (kind.same(given.answer, one.expect, tolerance, shape)) correct += 1
      // Refuse as soon as even perfect remaining answers cannot reach the
      // unchanged bar. Waiting until this whole round ends can waste every
      // remaining request in a failed one-pass calibration.
      if (attempts - (asked - correct) < Math.ceil(attempts * passWhen)) break calibration
    }
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
    passed: !identityDrift && correct >= Math.ceil(attempts * passWhen),
    ...(identityDrift ? {invalidated: true} : {}),
    needed: Math.ceil(attempts * passWhen),
  }
}

/** The first candidate that gets every case right, every time. Order is the caller's. */
/**
 * A key that changes whenever anything that could change the outcome changes:
 * the question, answer meanings, cases, labels, bar, or who is available to ask.
 *
 * Identifies calibration inputs, so qualification is reused only for those
 * inputs. It does not bind a review to the current publication candidate.
 */
const keyCache = new Map()

// BLAKE3 hashed in this process, by the same library the content-identity tool uses. One `b3sum` process per key
// cost 2-3 s of exec wait on a busy computer and ran past its timeout, so every rubric was refused.

/** The BLAKE3 identity of bytes as 64 hex characters. */
export function blake3Hex(bytes) {
  return Buffer.from(blake3(bytes)).toString('hex')
}

/** Reuse the installed content-identity owner. */
export function blake3Material(material) {
  if (keyCache.has(material)) return keyCache.get(material)
  let digest
  try {
    digest = blake3Hex(typeof material === 'string' ? Buffer.from(material, 'utf8') : material)
  } catch {
    throw new VerdictRefused('the BLAKE3 owner could not identify calibration inputs; no cached qualification can be trusted')
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new VerdictRefused('the BLAKE3 owner returned no usable calibration identity')
  if (keyCache.size >= 64) keyCache.delete(keyCache.keys().next().value)
  keyCache.set(material, digest)
  return digest
}

/** Exact bounded judge-owner source bytes, shared by qualification and held-out evaluation.
 * This binds the local adapters, prompt construction, model-server code and consumers.
 * Third-party runtime libraries and remote implementation bytes remain outside this identity.
 */
export function judgeSourceIdentity(directory = dirname(fileURLToPath(import.meta.url))) {
  try {
    const files = readdirSync(directory).filter(name => /\.(?:mjs|py)$/.test(name)).sort()
    if (!files.length) throw new Error('no judge sources')
    const ownerRoot = dirname(directory), pending = files.map(name => resolve(directory, name)), seen = new Map()
    // Follow only declared relative local module imports within this tool.
    // No directory recursion, installed dependency walk, secret or customer DATA read.
    for (let index = 0; index < pending.length; index++) {
      if (pending.length > 256) throw new Error('judge source closure exceeded its bounded owner')
      const path = pending[index]
      if (seen.has(path)) continue
      const source = readFileSync(path, 'utf8')
      seen.set(path, source)
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.(?:mjs|py))['"]/g)) {
        const imported = resolve(dirname(path), match[1])
        if (imported.startsWith(`${ownerRoot}${sep}`) && !seen.has(imported) && !pending.includes(imported)) pending.push(imported)
      }
    }
    return `blake3:${blake3Material(JSON.stringify([...seen].map(([path, source]) => [relative(directory, path), source]).sort((a, b) => a[0].localeCompare(b[0]))))}`
  } catch {
    throw new VerdictRefused('judge source bytes are unavailable; no source-bound qualification can be trusted')
  }
}

const safeEndpoint = value => {
  if (typeof value !== 'string' || !value) return null
  try {
    const endpoint = new URL(value)
    endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''
    return endpoint.href
  } catch { return null }
}

/** A name is a label, not a transport/build identity. Credentials never enter this key. */
export function candidateRouteKey(candidate) {
  return `blake3:${blake3Material(JSON.stringify({name: candidate?.name ?? null,
    endpoint: safeEndpoint(candidate?.reach?.endpoint), model: candidate?.reach?.model ?? null,
    samples: candidate?.reach?.samples ?? null, max_tokens: candidate?.reach?.max_tokens ?? null,
    accepts_characters: candidate?.accepts_characters ?? null, identity: candidate?.identity ?? null,
    identity_required: candidate?.identity_required === true,
    only_for_rubrics: Array.isArray(candidate?.only_for_rubrics) ? [...candidate.only_for_rubrics].sort() : null}))}`
}

/** Resolve the actual offered candidate; never borrow an adapter merely because its model has the same name. */
export function askingForCandidate(asking, candidate) {
  const exact = asking.filter(one => one.candidate === candidate)
  if (exact.length === 1) return exact[0]
  const key = candidateRouteKey(candidate)
  const matches = asking.filter(one => candidateRouteKey(one.candidate) === key)
  if (matches.length !== 1) throw new VerdictRefused('the chosen candidate has no unique offered route; no request was sent')
  return matches[0]
}

/** A historical name-only verdict may point at a line only when its rubric has one unambiguous offered source. */
export function askingForVerdict(asking, verdict, rubric) {
  const matches = asking.filter(one => one.candidate.name === verdict.answered_by && candidatesFor(rubric, [one.candidate]).length
    && (!verdict.answered_by_route || candidateRouteKey(one.candidate) === verdict.answered_by_route))
  if (matches.length !== 1) throw new VerdictRefused('the verdict has no unique offered route; no follow-up request was sent')
  return matches[0]
}

export function calibrationKey(rubric, candidates, passes, sourceIdentity = judgeSourceIdentity()) {
  candidates = candidatesFor(rubric, candidates)
  const material = JSON.stringify([
    rubric.question,
    rubric.shape,
    rubric.cases,
    rubric.tolerance ?? null,
    rubric.passWhen ?? 1,
    ...(rubric.adaptiveReview ? [rubric.adaptiveReview] : []),
    candidates.map(one => ({name: one.name, endpoint: safeEndpoint(one.reach?.endpoint), model: one.reach?.model ?? null,
      samples: one.reach?.samples ?? null, max_tokens: one.reach?.max_tokens ?? null, accepts_characters: one.accepts_characters ?? null,
      identity_required: one.identity_required === true})),
    passes,
    sourceIdentity,
    rubric.inputPolicy ?? null,
    // Qualification belongs to the effective decision and freshness policy,
    // not only the answer labels. A later policy change must be measured again.
    {bands: rubric.bands ?? null, whenUnknown: rubric.whenUnknown ?? null,
      bandsRead: rubric.bandsRead ?? 'confidence', maxAgeHours: rubric.maxAgeHours ?? 24},
  ])
  return `blake3:${blake3Material(material)}`
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
const unreached = row => row.unmeasured === true || row.errors > 0 && row.first_error !== 'TimeoutError'

/** Refused because nothing has been calibrated for this rubric and set of judges yet. */
export class NotCalibratedYet extends VerdictRefused {}

/** Refused because calibration already finished for this rubric and no judge passed it. */
export class NothingPassedCalibration extends VerdictRefused {}

/**
 * Which build of each judge a calibration measured. A candidate may carry an
 * `identity` (a served model's digest or snapshot); the key holds the route, so
 * a judge whose weights changed under the same name kept a result it never
 * earned. Both readers reject an observed mismatch; the separate run measures
 * again when one differs. A provider with no observed identity remains unknown.
 */
const identitiesOf = candidates => Object.fromEntries(candidates.filter(one => one?.identity).map(one => [one.name, one.identity]))
export const sameJudgesAs = (known, candidates) =>
  candidates.every(one => !one.identity_required || Boolean(one.identity) || (known?.chosen && known.chosen !== one.name)) &&
  Object.entries(identitiesOf(candidates)).every(([name, identity]) => known?.identities?.[name] === identity)

/** Unknown/missing/future timestamps are not proof of current qualification. */
export function calibrationIsCurrent(known, rubric, now = Date.now()) {
  const at = Date.parse(known?.at)
  return Number.isFinite(at) && at <= now && now - at < (rubric.maxAgeHours ?? 24) * 3600000
}

/** Losses throttle retries only inside their observed, nonfuture time window. */
export function calibrationLossIsCurrent(known, now = Date.now()) {
  const at = Date.parse(known?.at)
  return !known?.chosen && Number.isFinite(at) && at <= now && now - at < LOSSES_KEPT_MS
}

function checkPasses(passes) {
  if (!Number.isSafeInteger(passes) || passes < 1) {
    throw new VerdictRefused('calibration passes must be a positive safe integer; zero cases cannot qualify a judge')
  }
}

/**
 * The judges a rubric may be asked of. A provider row that names `only_for_rubrics`
 * is offered to those rubrics and no others, so content leaves the machine only
 * for the questions its owner approved sending. Every caller that picks, keys or
 * lists judges for a rubric reads them through here.
 */
export const candidatesFor = (rubric, candidates) => {
  const allowed = (Array.isArray(candidates) ? candidates : []).filter(one => !Array.isArray(one?.only_for_rubrics) || one.only_for_rubrics.includes(rubric?.id))
  const seen = new Map(), ambiguous = new Set()
  for (const one of allowed) {
    const key = candidateRouteKey(one)
    if (seen.has(one.name) && seen.get(one.name) !== key)
      ambiguous.add(one.name)
    seen.set(one.name, key)
  }
  // A broken alias is not evidence against a different, identified provider.
  // None of its conflicting builds is eligible; clear sibling routes remain usable.
  const usable = allowed.filter(one => !ambiguous.has(one.name))
  if (!usable.length && ambiguous.size)
    throw new VerdictRefused('same-named judges have ambiguous routes for this rubric; no request was sent')
  // Repeated identical rows do not add a vote or overwrite a cached named score.
  return usable.filter((one, at) => usable.findIndex(other => candidateRouteKey(other) === candidateRouteKey(one)) === at)
}

/** Persistence is part of qualification when a store was requested. Unknown or
 * refused writes cannot become cached success or erased candidate history. */
function retainCalibration(remember, key, score) {
  // Timestamp alone cannot distinguish two acknowledgments in one millisecond.
  const value = {...score, retention_id: randomUUID()}
  const started = Date.now()
  let written, readback
  try {
    written = remember.set(key, value)
    const finished = Date.now(), at = Date.parse(written?.value?.at)
    if (written?.status !== 'stored' || !Number.isFinite(at) || at < started || at > finished)
      throw new Error('write not acknowledged with current identity')
    readback = remember.get(key)
    if (!readback || typeof readback !== 'object' || readback.at !== written.value.at
        || Object.keys(value).some(field => !Object.hasOwn(written.value, field)
          || !isDeepStrictEqual(written.value[field], value[field])
          || !Object.hasOwn(readback, field) || !isDeepStrictEqual(readback[field], value[field])))
      throw new Error('readback mismatch')
  } catch {
    throw new NotCalibratedYet('qualification memory did not retain the current result; no cached qualification was adopted')
  }
}

export async function chooseCandidate({candidates: onOffer, rubric, ask, passes, remember = null, calibrate = true}) {
  checkPasses(passes)
  const candidates = candidatesFor(rubric, onOffer)
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new VerdictRefused('no candidate classifier was offered, so there is nothing that could answer')
  }

  const sourceIdentity = judgeSourceIdentity()
  const key = remember ? calibrationKey(rubric, candidates, passes, sourceIdentity) : null
  // A caller under a deadline of seconds only reads what calibration already
  // settled. Calibrating inside that deadline took over two minutes across the
  // local models, was cut off every time, saved nothing, and started again on
  // the next turn: 20,000 turns in one day without one verdict. Calibration
  // runs on its own (a `calibrate` request, or the caller's own readiness run) and this reads its result.
  if (!calibrate) {
    const kept = key ? remember.get(key) : null
    const known = kept && sameJudgesAs(kept, candidates) ? kept : null
    const chosen = known?.chosen ? candidates.find(one => one.name === known.chosen) : null
    if (chosen && calibrationIsCurrent(known, rubric)) return {chosen, scoreboard: known.scoreboard ?? [], from_memory: true}
    if (known?.complete && calibrationLossIsCurrent(known)) {
      throw new NothingPassedCalibration(`no candidate answered every calibration case correctly: ${describeScoreboard(known.scoreboard ?? [])}`)
    }
    throw new NotCalibratedYet('this rubric has not been calibrated against the judges on offer yet')
  }
  // Scores of candidates that did NOT pass, kept for six hours. The caller
  // runs under a deadline measured in seconds, and one slow local model can
  // outlast it, so a calibration that only saved its result at the very end
  // never saved anything and started over on every fire (the
  // before-a-call judge re-tested every local model before every tool call).
  // Keeping each loss as it happens lets the next fire resume where this one
  // was cut off. The six hours are what let a model that was down, or a rubric that
  // nothing passes, be tried again without ever pinning an answer.
  let scoreboard = []
  const identities = identitiesOf(candidates)
  if (remember && key) {
    const kept = remember.get(key)
    const known = kept && sameJudgesAs(kept, candidates) ? kept : null
    if (known?.chosen) {
      const chosen = candidates.find(one => one.name === known.chosen)
      // A remembered name that is no longer on offer is not an answer.
      if (chosen && calibrationIsCurrent(known, rubric)) return {chosen, scoreboard: known.scoreboard ?? [], from_memory: true}
    } else if (known && calibrationLossIsCurrent(known)) {
      // Only real losses are kept. A candidate that failed to ANSWER (a refused
      // connection, a busy server) was never measured, and skipping it for six
      // hours left a rubric uncalibrated behind a single dropped request.
      scoreboard = (known.scoreboard ?? []).filter(row => !row.passed && !unreached(row))
    }
  }

  // The canonical store checks its existing lock/read before any new model work,
  // without writing a probe row or holding a lock across asynchronous scoring.
  // Another writer can still arrive later, so every actual write needs readback.
  if (typeof remember?.availability === 'function') {
    let available
    try { available = remember.availability() } catch {}
    if (available?.status !== 'available')
      throw new NotCalibratedYet('qualification memory unavailable before calibration; no model was asked')
  }

  for (const candidate of candidates) {
    if (scoreboard.some(row => row.candidate === (candidate?.name ?? String(candidate)))) continue
    const score = await scoreCandidate({candidate, rubric, ask, passes})
    if (judgeSourceIdentity() !== sourceIdentity)
      throw new NotCalibratedYet('judge source changed during calibration; current source must be measured again')
    scoreboard.push(score)
    if (!score.passed && remember && key) retainCalibration(remember, key, {chosen: null, scoreboard, identities})
    if (score.passed) {
      // A candidate ahead of this one that lost because it could not be
      // reached was never measured, so this choice holds only for this outage.
      // Remembering it pinned a rubric to a local server for good once the
      // hosted one was out of credit, and every later ask failed on a refused
      // connection after the local server stopped.
      const outageDecided = scoreboard.some(row => row !== score && unreached(row))
      // Retain the actual trials even when an outage prevents pinning a choice.
      // The next readiness run still retries the unavailable preferred route.
      if (remember && key) retainCalibration(remember, key, {
        chosen: !outageDecided && (!candidate.identity_required || candidate.identity) ? candidate.name : null,
        scoreboard, identities,
      })
      return {chosen: candidate, scoreboard}
    }
  }
  // Every candidate was measured and none passed. Kept as a finished result, so
  // callers stop asking for six hours instead of re-running the same losses,
  // unless a candidate could not be reached, which is an outage, not a result.
  if (remember && key && !scoreboard.some(unreached)) retainCalibration(remember, key, {chosen: null, complete: true, scoreboard, identities})
  throw new VerdictRefused(
    'no candidate answered every calibration case correctly, so nothing here has a verdict worth having on ' +
      'this question. Using one anyway would be inventing confidence rather than measuring it. Scoreboard: ' +
      describeScoreboard(scoreboard),
  )
}

export function describeScoreboard(scoreboard) {
  return scoreboard
    .map(row => {
      const asked = Number.isSafeInteger(row.asked) && row.asked >= 0 && row.asked <= row.attempts ? row.asked : null
      const sample = asked === null ? `${row.correct} correct; asked unknown; ${row.attempts} planned`
        : `${row.correct}/${asked} asked; ${row.attempts} planned; ${row.attempts - asked} unasked`
      return `${row.candidate} ${sample}${row.errors > 0 ? ` (${row.errors} no answer${row.first_error ? `: ${row.first_error}` : ''})` : ''}`
    })
    .join('; ')
}

// Darwin open(2) flag Node does not export. The kernel releases this lock when
// its descriptor closes. The earlier wx protocol instead held the pathname by
// existence; its empty sentinel must never be mistaken for a kernel-lock file.
const O_EXLOCK = 0x20
const CACHE_LOCK_MARKER = Buffer.from('trillion.judge-cache-kernel-lock/v1\n', 'utf8')

function cacheLockStat(path, descriptor) {
  const held = fstatSync(descriptor, {bigint: true}), named = lstatSync(`${path}.lock`, {bigint: true})
  if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino
      || held.uid !== BigInt(process.getuid()) || (held.mode & 0o777n) !== 0o600n || held.nlink !== 1n
      || held.size < 0n || held.size > BigInt(CACHE_LOCK_MARKER.length))
    throw new Error('cache lock is not a private bound regular file')
  return held
}

function verifyCacheLock(path, descriptor) {
  const before = cacheLockStat(path, descriptor)
  // Preserve every legacy sentinel, including one whose creator is unknown or
  // no longer running. Existence remains busy under that earlier protocol.
  if (before.size === 0n) throw Object.assign(new Error('legacy cache lock remains held by existence'), {code: 'EAGAIN'})
  if (before.size !== BigInt(CACHE_LOCK_MARKER.length)) throw new Error('cache lock protocol is unavailable')
  const bytes = Buffer.alloc(CACHE_LOCK_MARKER.length)
  if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(CACHE_LOCK_MARKER))
    throw new Error('cache lock protocol is unavailable')
  const after = cacheLockStat(path, descriptor)
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].some(key => before[key] !== after[key]))
    throw new Error('cache lock changed during validation')
}

/** The cache's exclusive writer lock as an open descriptor (close it to release); throws EAGAIN while another holds it. */
export function holdCacheLock(path) {
  if (process.platform !== 'darwin' || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined)
    throw Object.assign(new Error('kernel open locks are unavailable here'), {code: 'ENOTSUP'})
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK
  let descriptor = null, created = false
  try {
    try { descriptor = openSync(`${path}.lock`, flags | constants.O_CREAT | constants.O_EXCL, 0o600); created = true }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      descriptor = openSync(`${path}.lock`, flags)
    }
    if (created) {
      if (cacheLockStat(path, descriptor).size !== 0n) throw new Error('new cache lock changed before initialization')
      writeFileSync(descriptor, CACHE_LOCK_MARKER); fsyncSync(descriptor)
    }
    verifyCacheLock(path, descriptor)
    return descriptor
  } catch (error) {
    if (descriptor !== null) try { closeSync(descriptor) } catch {}
    // An interrupted initialization stays unavailable; never unlink or retry an
    // uncertain lock name. Read-only cached results remain usable separately.
    throw error
  }
}

/** One existing cache owner. Cooperating writers take a nonblocking lock and atomically
 * replace one complete file. Busy/corrupt/unwritable caches are explicit failures,
 * never empty-history writes. A live holder's lock is never stolen; a dead holder holds
 * nothing. External writers ignoring this owner and power-loss durability are outside
 * this contract. */
export function rememberedIn(path) {
  if (!path) return null
  // Refuse cache history above this finite bound intact; never truncate it.
  const cacheMaxBytes = 64 * 1024 * 1024
  const sameCacheFile = (left, right) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key])
  const readCacheText = () => {
    if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new Error('cache safety flags unavailable')
    let descriptor
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if (error.code === 'ENOENT') error.code = 'CACHE_INITIAL_ABSENT'
      throw error
    }
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size < 0 || opened.size > cacheMaxBytes || !sameCacheFile(opened, lstatSync(path)))
        throw new Error('cache is not a stable bounded regular file')
      const bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (count <= 0) throw new Error('cache changed during read')
        offset += count
      }
      if (!sameCacheFile(opened, fstatSync(descriptor)) || !sameCacheFile(opened, lstatSync(path)))
        throw new Error('cache changed during read')
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    } catch (error) {
      // Only the failed initial open means a new cache. Once opened, a missing
      // name is a race and must never turn known history into an empty store.
      if (error.code === 'ENOENT') throw new Error('cache pathname changed during read')
      throw error
    } finally { closeSync(descriptor) }
  }
  const readAll = (withPresence = false) => {
    let held
    try { held = JSON.parse(readCacheText()) }
    catch (error) { if (error.code === 'CACHE_INITIAL_ABSENT') return withPresence ? {value: {}, missing: true} : {}; throw error }
    if (!held || typeof held !== 'object' || Array.isArray(held)) throw new Error('invalid cache')
    return withPresence ? {value: held, missing: false} : held
  }
  const mutate = (change, {write = true} = {}) => {
    let lock = null, temporary = null, descriptor = null
    try {
      mkdirSync(dirname(path), {recursive: true, mode: 0o700})
      try { lock = holdCacheLock(path) }
      catch (error) { return {status: 'unavailable', reason: error.code === 'EAGAIN' ? 'cache_busy' : 'cache_unavailable'} }
      const current = readAll(true), all = current.value, result = change(all, {missing: current.missing})
      verifyCacheLock(path, lock)
      if (!write) return {status: 'available'}
      const serialized = JSON.stringify(all, null, 2)
      if (Buffer.byteLength(serialized, 'utf8') > cacheMaxBytes) throw new Error('cache exceeds finite size limit')
      temporary = `${path}.${randomUUID()}.tmp`
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, serialized); fsyncSync(descriptor)
      closeSync(descriptor); descriptor = null
      verifyCacheLock(path, lock)
      renameSync(temporary, path); temporary = null
      // Actual consumer readback, including the archive, before claiming retention.
      if (JSON.stringify(readAll()) !== JSON.stringify(all)) throw new Error('cache readback mismatch')
      return {status: 'stored', value: result}
    } catch { return {status: 'unavailable', reason: 'cache_unavailable'} }
    finally {
      if (descriptor !== null) try { closeSync(descriptor) } catch {}
      if (temporary) try { unlinkSync(temporary) } catch {}
      // The lock file stays: removing it would let a waiter lock a new file while this name is still held.
      if (lock !== null) try { closeSync(lock) } catch {}
    }
  }
  return {
    // Shared atomic JSON owner used by calibration and correction memory. The
    // callback mutates the current object under the existing exclusive lock.
    transact: mutate,
    // Current lock/read availability only; does not promise a later write.
    availability: () => mutate(() => null, {write: false}),
    readState: () => {
      try {
        const held = JSON.parse(readCacheText())
        if (!held || typeof held !== 'object' || Array.isArray(held)) throw new Error('invalid cache')
        return {status: 'read', value: held}
      } catch (error) {
        return error.code === 'CACHE_INITIAL_ABSENT' ? {status: 'missing'}
          : {status: 'unavailable', reason: 'cache_unavailable'}
      }
    },
    get: key => { try { return readAll()[key] ?? null } catch { return null } },
    set: (key, value) => mutate(all => {
      const kept = {...value, at: new Date().toISOString()}
      Object.defineProperty(all, key, {value: kept, enumerable: true, configurable: true, writable: true})
      return kept
    }),
    recordAttempt: (key, value) => mutate(all => {
      if (!['held-out-evaluation', 'source-discovery-evaluation'].includes(value?.kind)
          || typeof value.evaluation_identity !== 'string') throw new Error('not an evaluation')
      const before = Object.hasOwn(all, key) ? all[key] : null
      if (before && (before.kind !== value.kind || before.evaluation_identity !== value.evaluation_identity)) throw new Error('evaluation key collision')
      if (before) all[`${key}:attempt:${randomUUID()}`] = before
      const kept = {...value, attempt_id: randomUUID(), previously_measured: !!before,
        retention: {status: 'stored', archived_prior: !!before}, at: new Date().toISOString()}
      all[key] = kept
      return kept
    }),
  }
}

/** Shared by held-outs and discovery; injected stores without attempt retention
 * cannot silently fall back to destructive deterministic-key replacement. */
export function retainEvaluationAttempt(remember, key, report) {
  if (!remember) { report.retention = {status: 'not_requested'}; return }
  let result
  try { result = remember.recordAttempt?.(key, report) } catch {}
  if (result?.status === 'stored' && result.value) Object.assign(report, result.value)
  else report.retention = {status: 'unavailable', reason: result?.reason ?? 'attempt_retention_not_supported'}
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
  return verdictFrom({rubric, checked, chosen, scoreboard, given, content, passes, sureAt, now})
}

/** One verdict row from a passed candidate's answer: the same row whether it was asked alone or with other questions. */
function verdictFrom({rubric, checked, chosen, scoreboard, given, content, passes, sureAt = null, now = () => new Date()}) {
  if (chosen?.identity_required && (typeof given?.answered_by_identity !== 'string' || !given.answered_by_identity))
    throw new VerdictRefused('the response has no required served model identity; this response is not a qualified verdict')
  if (given?.answered_by_identity !== undefined && chosen?.identity && given.answered_by_identity !== chosen.identity)
    throw new VerdictRefused('the served model build changed after qualification; this response is not a qualified verdict')
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
    answered_by_identity: given?.answered_by_identity ?? null,
    qualified_model_identity: chosen?.identity ?? null,
    model_identity_provenance: given?.answered_by_identity ? 'response' : chosen?.identity ? 'health-or-inventory-only' : 'unknown',
    answered_by_route: candidateRouteKey(chosen),
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
      adaptive_review: checked.adaptiveReview,
    },
  }
}

/** Why a rubric got no verdict, as the kind a log row and its caller read. */
export function refusalOf(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.code ?? ''} ${error?.name ?? ''}`
  const kind = error instanceof NothingPassedCalibration ? 'no-calibrated-candidate'
    : error instanceof NotCalibratedYet ? 'not-calibrated'
      : /ECONNREFUSED|fetch failed|TimeoutError|timed out|aborted/i.test(text) ? 'unreachable'
        : error instanceof VerdictRefused ? 'refused' : 'failed'
  return {kind, skipped: `${kind === 'refused' ? 'refused' : 'failed'}: ${String(error?.message ?? error).slice(0, 400)}`}
}

/**
 * Every rubric's verdict about ONE piece of content, asking each chosen judge
 * once for all of its questions.
 *
 * A judge that takes one state and a map of questions (`askMany`) answers them
 * in one request; on the decision server every question is still scored in
 * its own row, so each answer is the one that question gets asked alone, which
 * is the answer calibration measured. A judge without `askMany` is asked each
 * question on its own, at once. Each rubric still needs the judge calibration
 * chose for it; a rubric with none is refused, never answered by another.
 *
 * `asking` is whoCanBeAsked's list. -> [{rubric, verdict} | {rubric, error: {kind, skipped}}], in order.
 */
export async function judgeMany({rubrics, content, candidates, asking, passes = 1, remember = null, calibrate = true, now = () => new Date()}) {
  const via = candidate => askingForCandidate(asking, candidate)
  const ask = args => via(args.candidate).ask(args)
  const results = rubrics.map(rubric => ({rubric}))
  const byJudge = new Map()
  await Promise.all(results.map(async one => {
    try {
      const checked = checkRubric(one.rubric)
      const {chosen, scoreboard} = await chooseCandidate({candidates, rubric: checked, ask, passes, remember, calibrate})
      checkFits(content, chosen)
      Object.assign(one, {checked, chosen, scoreboard})
      const route = candidateRouteKey(chosen)
      byJudge.set(route, [...(byJudge.get(route) ?? []), one])
    } catch (error) {
      one.error = refusalOf(error)
    }
  }))
  await Promise.all([...byJudge].map(async ([route, group]) => {
    const judge = via(group[0].chosen)
    const questions = Object.fromEntries(group.map((one, index) => [`q${index}`, {question: one.checked.question, shape: one.checked.shape}]))
    try {
      const answers = typeof judge.askMany === 'function'
        ? await judge.askMany({candidate: group[0].chosen, content, asking: questions})
        : Object.fromEntries(await Promise.all(Object.entries(questions).map(async ([id, one]) => [id, await judge.ask({candidate: group[0].chosen, ...one, content})])))
      group.forEach((one, index) => {
        try {
          one.verdict = verdictFrom({...one, given: answers[`q${index}`], content, passes, now})
        } catch (error) {
          one.error = refusalOf(error)
        }
      })
    } catch (error) {
      for (const one of group) one.error = refusalOf(error)
    }
  }))
  return results.map(({rubric, verdict, error}) => (verdict ? {rubric, verdict} : {rubric, error}))
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
