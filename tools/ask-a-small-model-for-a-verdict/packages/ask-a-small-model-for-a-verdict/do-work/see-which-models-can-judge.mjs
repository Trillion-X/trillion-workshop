#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/see-which-models-can-judge.mjs
//
// Score every available classifier against every rubric and print the board.
//
// This exists because "we added a judge" is not a fact worth having. The fact
// worth having is WHICH judge agrees with answers that were already known, on
// THIS question, and the only way to learn it is to ask all of them and look.
// A model that is excellent at writing code can still be a coin flip at
// deciding whether a turn did what it claimed, and nothing about its name, its
// size or its price tells you which.
//
// It changes nothing. It asks and it reports.
//
// Usage
//   node see-which-models-can-judge.mjs --rubrics <path> [--passes 2]

import {readFile} from 'node:fs/promises'
import {checkRubric, scoreCandidate} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'
import {whoCanBeAsked} from './who-can-be-asked.mjs'

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  if (!values.get('rubrics')) throw new Error('usage: see-which-models-can-judge.mjs --rubrics <path> [--passes 2]')
  return {rubrics: values.get('rubrics'), passes: Number(values.get('passes') || 2)}
}

async function main() {
  const {rubrics: rubricsPath, passes} = readArguments(process.argv.slice(2))
  const data = JSON.parse(await readFile(rubricsPath, 'utf8'))

  // A provider is a DATA row: which adapter, and where to reach it. That is
  // what lets one hosted service and one running on this machine be the same
  // kind of thing, told apart only by calibration.
  const asking = await whoCanBeAsked(data, {phase: 'calibration'})
  if (asking.length === 0) {
    process.stdout.write('Nothing is available to ask.\n')
    return
  }

  for (const rubric of data.rubrics ?? []) {
    const checked = checkRubric(rubric)
    process.stdout.write(
      `\n${rubric.id}\n  ${checked.cases.length} cases, each asked ${passes} times, so ${checked.cases.length * passes} answers to get right\n\n`,
    )
    for (const {candidate, ask, via} of asking) {
      const started = Date.now()
      const score = await scoreCandidate({candidate, rubric: checked, ask, passes})
      const took = Date.now() - started
      const verdict = score.passed ? 'CAN JUDGE THIS' : 'no'
      const wrong = score.attempts - score.correct - score.errors
      process.stdout.write(
        `  ${score.correct}/${score.asked}  ${String(took).padStart(6)}ms  ${candidate.name} (${via})` +
          `  ${verdict}${wrong > 0 ? `, ${wrong} wrong` : ''}${score.errors > 0 ? `, ${score.errors} no answer` : ''}` +
          // Said out loud, because a score against a total nobody reached is
          // how a good candidate gets read as a bad one.
          `${score.stopped_early ? `, stopped after ${score.asked} of ${score.attempts}` : ''}\n`,
      )
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
