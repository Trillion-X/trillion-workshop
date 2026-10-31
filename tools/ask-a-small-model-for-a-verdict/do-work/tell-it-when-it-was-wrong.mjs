#!/usr/bin/env node
// tools/ask-a-small-model-for-a-verdict/do-work/tell-it-when-it-was-wrong.mjs
//
// Turn a verdict that was wrong into a case the judge is tested against.
//
// The gap this closes
//   Everything else in this package gets better only when a person edits a
//   rubric by hand. The judgements themselves are recorded and then nothing
//   reads them for correctness, so a question that is subtly wrong stays wrong
//   and keeps being asked. Three times while this package was being built a
//   classifier disagreed with a label and the classifier turned out to be
//   right; each time the fix was made by hand, and nothing about the system
//   would have changed if nobody had bothered.
//
//   A wrong verdict is the most valuable thing this system produces. It is a
//   labelled example at exactly the boundary the question is failing on, which
//   is the hardest kind of case to invent and the only kind that moves a model
//   off a mistake. Those were being thrown away.
//
// What this does not do
//   It does not edit the question, thresholds, or model choice. It records a
//   validated labelled correction. Declared stricter qualification DATA applies
//   through the normal reader after that record. Everything downstream follows on its
//   own: candidates are re-scored against the larger set on the next run, a
//   model that cannot handle the new case stops being selected for it. Nothing
//   here tunes confidence thresholds or consumes held-out scores. Nothing here decides any of
//   that, which is what keeps it honest.
//
//   Adding cases makes a rubric harder to pass. That is the intended
//   direction. A question that gets easier as it learns is not learning.
//
// Usage
//   tell-it-when-it-was-wrong.mjs --rubrics <path> --rubric <id>
//     --should-have-been <true|false|option>
//     [--log <path>]        take the offending text from the last verdict
//     [--about "<text>"]    or give it directly
//     [--because "<text>"]  why the original answer was wrong

import {writeFileSync} from 'node:fs'
import {checkRubric, blake3Material, VerdictRefused} from './ask-for-a-verdict.mjs'
import {readJudgeLogFile, maxStructuredReadBytes} from './judge-log-frontier.mjs'

const normalized = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US')
const caseIdentity = rubric => `blake3:${blake3Material(JSON.stringify([rubric.question, rubric.answer_shape, rubric.calibration]))}`
const readRubrics = path => {
  const result = readJudgeLogFile(path, maxStructuredReadBytes)
  if (result.status !== 'read') throw new VerdictRefused('correction rubric DATA is unavailable, unsafe, oversized or changed during read')
  return result.bytes.toString('utf8')
}

/** The most recent verdict for this rubric that kept what it looked at. */
export function lastVerdictFor(logPath, rubricId) {
  let rows = []
  try {
    const result = readJudgeLogFile(logPath)
    if (result.status !== 'read') return null
    rows = result.bytes.toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return null
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.rubric_id === rubricId && row.asked_about?.excerpt) return row
  }
  return null
}

/** Read a label the way the rubric's own cases are written. */
export function asExpected(given) {
  if (given === 'true') return true
  if (given === 'false') return false
  const asNumber = Number(given)
  return Number.isFinite(asNumber) && String(asNumber) === given.trim() ? asNumber : given
}

/**
 * Add the case, unless this exact text is already labelled.
 *
 * A duplicate is not harmless. Cases are counted to work out the pass bar, so
 * the same text twice quietly doubles its weight, and a rubric can be dragged
 * toward one example by repeating it rather than by being wrong about
 * different things.
 */
export function addCase(rubric, content, expect, because, attribution = {}) {
  const checked = checkRubric(rubric)
  if (typeof content !== 'string' || !content.trim()) throw new VerdictRefused('a correction needs nonempty full content')
  if (!checked.kind.accepts(expect, checked.shape)) throw new VerdictRefused('correction label is outside the rubric answer shape')
  if ((rubric.held_out?.cases ?? []).some(one => typeof one?.content === 'string' && normalized(one.content) === normalized(content)))
    throw new VerdictRefused('held-out content is reserved for evaluation and cannot become calibration or tuning')
  const already = rubric.calibration.find(one => one.content === content)
  if (already) {
    if (Object.is(already.expect, expect)) return {added: false, changed: false, why: 'this case is already there with the same answer'}
  }
  // Check the complete proposed corpus before touching the caller's object or disk.
  const proposed = structuredClone(rubric)
  const prior = proposed.calibration.find(one => one.content === content)
  const correction = {at: new Date().toISOString(), label_owner: attribution.by || 'unattributed',
    source_reference: attribution.source || null, reason: because || null}
  if (prior) {
    prior.label_history = [...(prior.label_history ?? []), {...correction, previous: prior.expect, replacement: expect}]
    prior.expect = expect
    prior.corrected = because ?? 'relabelled after the earlier label turned out to be wrong'
  } else proposed.calibration.push({
    content,
    expect,
    learned_from: 'a verdict that was wrong',
    correction,
    ...(because ? {because} : {}),
  })
  checkRubric(proposed)
  rubric.calibration = proposed.calibration
  return {added: !prior, changed: true, why: prior ? 'label corrected with prior label retained' : 'added'}
}

export async function main(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  const rubricsPath = values.get('rubrics')
  const rubricId = values.get('rubric')
  const shouldHaveBeen = values.get('should-have-been')
  if (!rubricsPath || !rubricId || shouldHaveBeen === undefined) {
    throw new Error(
      'usage: tell-it-when-it-was-wrong.mjs --rubrics <path> --rubric <id> --should-have-been <true|false|option> ' +
        '[--log <path>] [--about "<text>"] [--because "<text>"]',
    )
  }

  const original = readRubrics(rubricsPath)
  const settings = JSON.parse(original)
  const rubric = (settings.rubrics ?? []).find(one => one.id === rubricId)
  if (!rubric) throw new Error(`no rubric called ${rubricId} in ${rubricsPath}`)

  let content = values.get('about')
  if (content === undefined) {
    const found = lastVerdictFor(values.get('log'), rubricId)
    if (!found) {
      throw new Error(
        `nothing to learn from: no recorded verdict for ${rubricId} kept what it looked at. ` +
          'Give the text directly with --about, or check that the judge was run with a log.',
      )
    }
    if (found.asked_about.characters !== found.asked_about.excerpt.length)
      throw new VerdictRefused('the recorded excerpt is not proved to be the full reviewed content; give the complete case directly')
    content = found.asked_about.excerpt
  }

  const expect = asExpected(shouldHaveBeen)
  const before = caseIdentity(rubric)
  // A case declared anywhere as held-out is never a source for this tuning command.
  if ((settings.rubrics ?? []).some(one => (one.held_out?.cases ?? []).some(held =>
    typeof held?.content === 'string' && typeof content === 'string' && normalized(held.content) === normalized(content))))
    throw new VerdictRefused('held-out content is reserved for evaluation and cannot become calibration or tuning')
  const result = addCase(rubric, content, expect, values.get('because'), {by: values.get('by'), source: values.get('source')})
  if (readRubrics(rubricsPath) !== original) throw new VerdictRefused('rubric DATA changed during correction; retry against its current content')
  if (result.changed) writeFileSync(rubricsPath, JSON.stringify(settings, null, 2) + '\n')

  process.stdout.write(
    JSON.stringify(
      {
        rubric: rubricId,
        outcome: result.why,
        cases_now: rubric.calibration.length,
        calibration_before: before,
        calibration_after: caseIdentity(rubric),
        adaptive_response: result.changed ? 'current qualification invalidated by changed calibration; requalification required' : 'unchanged; no new evidence',
        // Said plainly because it is the consequence people forget: the bar
        // moved, and a model that used to pass may not any more.
        what_happens_next: result.changed ?
          'Current qualification no longer applies. Candidates must be evaluated against all ' +
          rubric.calibration.length +
          ' declared cases and satisfy the current qualification policy before their verdicts can be used. ' +
          'The normal readiness owner performs requalification; held-out scores remain separate.'
          : 'No new case or label was recorded; current source/model-bound qualification was not replaced.',
      },
      null,
      2,
    ) + '\n',
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    },
  )
}
