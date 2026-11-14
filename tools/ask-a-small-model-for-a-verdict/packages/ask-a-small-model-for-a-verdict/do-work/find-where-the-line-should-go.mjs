#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/find-where-the-line-should-go.mjs
//
// Work out where a rubric's thresholds belong by measuring, instead of picking
// a round number that sounds about right.
//
// Why this exists
//   A rubric says what to ask and what counts as a correct answer. It also says
//   how sure the classifier has to be before anyone is interrupted, and that
//   number was written by hand. Hand-written it was wrong, quietly and for a
//   while: a check concluded a mistake was happening 38 times and spoke 7
//   times, because 0.8 had been chosen to mean "quite sure" while the number it
//   was compared against measured distance above chance, where 0.8 means a peak
//   of 0.90. Nobody could see it. Silence looks exactly like nothing to report.
//
//   The rubric already contains the answer. Its calibration cases are labelled,
//   so the confidence the classifier assigns to known-true cases and to
//   known-false cases can simply be measured, and the line put where they
//   actually separate.
//
// What it will not do
//   It will not lower a threshold until the check starts talking. That is the
//   opposite failure and it is worse, because an interruption that is often
//   wrong teaches everyone to skip reading them, and then the correct one is
//   lost too. If true and false cases overlap, there is no line that separates
//   them and the honest output says so. The fix then is better cases or a
//   better question, not a bolder number.
//
// Usage
//   find-where-the-line-should-go.mjs --rubrics <path> [--rubric <id>]

import {readFileSync} from 'node:fs'
import {checkRubric, scoreCandidate} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'
import {classifiersFrom} from './route-to-the-owner-that-answers.mjs'

/**
 * Where to draw one line between two labelled groups.
 *
 * Every midpoint between adjacent observed values is tried and the one that
 * misplaces the fewest cases wins. Ties go to the higher line, because a
 * threshold that is slightly too strict stays quiet about something real,
 * while one that is slightly too loose speaks about something that is not.
 */
export function bestLine(above, below) {
  const points = [...above, ...below].sort((a, b) => a - b)
  if (points.length === 0) return null
  const tries = [points[0] - 0.01]
  for (let index = 1; index < points.length; index += 1) {
    tries.push((points[index - 1] + points[index]) / 2)
  }
  tries.push(points[points.length - 1] + 0.01)

  let best = null
  for (const line of tries) {
    const missed = above.filter(one => one < line).length + below.filter(one => one >= line).length
    if (!best || missed < best.misplaced || (missed === best.misplaced && line > best.line)) {
      best = {line: Math.round(Math.max(0, Math.min(1, line)) * 1000) / 1000, misplaced: missed}
    }
  }
  return best
}

/**
 * Ask one candidate every calibration case and keep the confidences by label.
 * Takes a rubric that has already been through checkRubric; running it through
 * again looks for an answer_shape that normalising has already consumed.
 */
export async function measure({rubric: checked, candidate, ask}) {
  const above = []
  const below = []
  for (const one of checked.cases) {
    let answer
    try {
      answer = await ask({candidate, question: checked.question, shape: checked.shape, content: one.content})
    } catch {
      continue
    }
    if (!answer || typeof answer.confidence !== 'number') continue
    if (!checked.kind.accepts(answer.answer, checked.shape)) continue
    const right = checked.kind.same(answer.answer, one.expect, checked.tolerance)
    // Only cases the classifier got RIGHT inform the line. A confidence
    // attached to a wrong answer says nothing about how sure it is when it is
    // correct, and letting it in here would move the line to accommodate a
    // failure rather than to separate the two groups.
    if (!right) continue
    ;(one.expect === true || one.expect === 'true' ? above : below).push(answer.confidence)
  }
  return {above, below}
}

export async function main(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  const rubricsPath = values.get('rubrics')
  if (!rubricsPath) throw new Error('usage: find-where-the-line-should-go.mjs --rubrics <path> [--rubric <id>]')

  const settings = JSON.parse(readFileSync(rubricsPath, 'utf8'))
  const {candidates, ask} = await classifiersFrom(rubricsPath)
  if (candidates.length === 0) {
    process.stdout.write('Nothing is available to ask, so no line can be measured.\n')
    return 1
  }

  const only = values.get('rubric')
  const wanted = (settings.rubrics ?? []).filter(one => !only || one.id === only)
  const found = []

  for (const rubric of wanted) {
    const checked = checkRubric(rubric)
    // Only a candidate that passes this rubric gets a say in where its line
    // goes. A classifier that cannot answer the question correctly has no
    // useful opinion about how sure it is.
    let chosen = null
    for (const candidate of candidates) {
      const score = await scoreCandidate({rubric: checked, candidate, ask, passes: 1})
      if (score.passed) {
        chosen = candidate
        break
      }
    }
    if (!chosen) {
      found.push({rubric: rubric.id, cannot: 'no candidate passes this rubric, so there is no line to draw'})
      continue
    }

    const {above, below} = await measure({rubric: checked, candidate: chosen, ask})
    if (above.length === 0 || below.length === 0) {
      found.push({
        rubric: rubric.id,
        measured_by: chosen.name,
        cannot:
          'the cases are one-sided, so nothing here shows what a confident NO looks like. ' +
          'Add cases that expect the opposite answer.',
      })
      continue
    }

    const line = bestLine(above, below)
    const sorted = list => list.slice().sort((a, b) => a - b)
    found.push({
      rubric: rubric.id,
      measured_by: chosen.name,
      when_it_is_true: {count: above.length, confidences: sorted(above)},
      when_it_is_false: {count: below.length, confidences: sorted(below)},
      line_should_be: line.line,
      cases_on_the_wrong_side: line.misplaced,
      currently: (rubric.confidence_bands ?? []).find(one => one.then === 'raise-it')?.at_least ?? null,
      clean_split: line.misplaced === 0,
    })
  }

  process.stdout.write(JSON.stringify(found, null, 2) + '\n')
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
