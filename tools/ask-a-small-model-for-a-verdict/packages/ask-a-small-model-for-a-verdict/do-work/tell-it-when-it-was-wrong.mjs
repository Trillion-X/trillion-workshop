#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/tell-it-when-it-was-wrong.mjs
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
//   It does not change the question, the thresholds, or which model is used.
//   It adds one labelled case and stops. Everything downstream follows on its
//   own: candidates are re-scored against the larger set on the next run, a
//   model that cannot handle the new case stops being selected for it, and the
//   measured threshold moves when the line moves. Nothing here decides any of
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

import {readFileSync, writeFileSync} from 'node:fs'

/** The most recent verdict for this rubric that kept what it looked at. */
export function lastVerdictFor(logPath, rubricId) {
  let rows = []
  try {
    rows = readFileSync(logPath, 'utf8')
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
export function addCase(rubric, content, expect, because) {
  rubric.calibration = rubric.calibration ?? []
  const already = rubric.calibration.find(one => one.content === content)
  if (already) {
    if (already.expect === expect) return {added: false, why: 'this exact case is already there with the same answer'}
    already.expect = expect
    already.corrected = because ?? 'relabelled after the earlier label turned out to be wrong'
    return {added: false, why: 'the case already existed with the other answer, so its label was corrected'}
  }
  rubric.calibration.push({
    content,
    expect,
    learned_from: 'a verdict that was wrong',
    ...(because ? {because} : {}),
  })
  return {added: true, why: 'added'}
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

  const settings = JSON.parse(readFileSync(rubricsPath, 'utf8'))
  const rubric = (settings.rubrics ?? []).find(one => one.id === rubricId)
  if (!rubric) throw new Error(`no rubric called ${rubricId} in ${rubricsPath}`)

  let content = values.get('about')
  if (!content) {
    const found = lastVerdictFor(values.get('log'), rubricId)
    if (!found) {
      throw new Error(
        `nothing to learn from: no recorded verdict for ${rubricId} kept what it looked at. ` +
          'Give the text directly with --about, or check that the judge was run with a log.',
      )
    }
    content = found.asked_about.excerpt
  }

  const expect = asExpected(shouldHaveBeen)
  const result = addCase(rubric, content, expect, values.get('because'))
  writeFileSync(rubricsPath, JSON.stringify(settings, null, 2))

  process.stdout.write(
    JSON.stringify(
      {
        rubric: rubricId,
        outcome: result.why,
        cases_now: rubric.calibration.length,
        // Said plainly because it is the consequence people forget: the bar
        // moved, and a model that used to pass may not any more.
        what_happens_next:
          'candidates are scored against all ' +
          rubric.calibration.length +
          ' cases on the next run, so one that cannot handle this will stop being chosen for this question. ' +
          'Run see-which-models-can-judge.mjs to see who still passes, and find-where-the-line-should-go.mjs ' +
          'because the threshold may have moved.',
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
