// Score every available classifier against every rubric and report the board.
//
// "We added a judge" is not a fact worth having. The fact worth having is WHICH
// judge agrees with answers that were already known, on THIS question, and the
// only way to learn it is to ask all of them. A model that is excellent at one
// job can be a coin flip at another, and nothing about its name, size or price
// tells you which. It changes nothing: it asks and it reports.

import {checkRubric, scoreCandidate} from './ask-for-a-verdict.mjs'

/** -> [{rubric, cases, passes, rows: [{via, took_ms, ...score, verdict}]}] */
export async function scoreboard({rubrics, asking, passes = 2}) {
  const board = []
  for (const rubric of rubrics) {
    const checked = checkRubric(rubric)
    const rows = []
    for (const {candidate, ask, via} of asking) {
      const started = Date.now()
      const score = await scoreCandidate({candidate, rubric: checked, ask, passes})
      rows.push({
        via,
        took_ms: Date.now() - started,
        ...score,
        wrong: score.asked - score.correct - score.errors,
        verdict: score.passed ? 'can judge this' : 'no',
      })
    }
    board.push({rubric: rubric.id ?? null, cases: checked.cases.length, passes, rows})
  }
  return board
}
