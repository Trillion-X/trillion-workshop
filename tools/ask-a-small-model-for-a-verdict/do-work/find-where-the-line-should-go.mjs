// Work out where a rubric's confidence threshold belongs by measuring, instead
// of picking a round number that sounds about right.
//
// The rubric's calibration cases are labelled, so the confidence a model gives
// known-true cases and known-false cases can be measured and the line put where
// they actually separate. It will not lower a threshold until a check starts
// talking: if true and false cases overlap there is no line, the honest output
// says so, and the fix is better cases or a better question, not a bolder
// number.

import {checkRubric, scoreCandidate} from './ask-for-a-verdict.mjs'

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
    // Only cases the classifier got RIGHT inform the line. A confidence
    // attached to a wrong answer says nothing about how sure it is when it is
    // correct, and letting it in here would move the line to accommodate a
    // failure rather than to separate the two groups.
    if (!checked.kind.same(answer.answer, one.expect, checked.tolerance)) continue
    ;(one.expect === true || one.expect === 'true' ? above : below).push(answer.confidence)
  }
  return {above, below}
}

const sorted = list => list.slice().sort((a, b) => a - b)

/**
 * One finding per rubric. `band` names the confidence band whose `at_least` is
 * the line being measured, so the finding can say where the line is now.
 */
export async function findLines({rubrics, candidates, ask, band = null}) {
  const found = []
  for (const rubric of rubrics) {
    const checked = checkRubric(rubric)
    // Only a candidate that passes this rubric gets a say in where its line
    // goes. A classifier that cannot answer the question correctly has no
    // useful opinion about how sure it is.
    let chosen = null
    for (const candidate of candidates) {
      if ((await scoreCandidate({rubric: checked, candidate, ask, passes: 1})).passed) {
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
    found.push({
      rubric: rubric.id,
      measured_by: chosen.name,
      when_it_is_true: {count: above.length, confidences: sorted(above)},
      when_it_is_false: {count: below.length, confidences: sorted(below)},
      line_should_be: line.line,
      cases_on_the_wrong_side: line.misplaced,
      currently: band === null ? null : (rubric.confidence_bands ?? []).find(one => one.then === band)?.at_least ?? null,
      clean_split: line.misplaced === 0,
    })
  }
  return found
}
