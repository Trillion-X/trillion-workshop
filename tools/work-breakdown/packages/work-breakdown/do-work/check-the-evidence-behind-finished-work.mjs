#!/usr/bin/env node
// packages/work-breakdown/do-work/check-the-evidence-behind-finished-work.mjs
//
// Ask a calibrated classifier whether the evidence recorded against each
// finished item actually establishes that the item is done.
//
// Why this exists and why a roll-up alone is not enough
//   The roll-up already refuses to count an item that claims done with no
//   `verified_by`, which was the first hole. But it cannot read. It sees that
//   a sentence EXISTS, not that the sentence says anything. So "verified: the
//   tests pass" counts exactly the same as "verified: 29 tests, 29 pass, 0
//   fail" and exactly the same as "verified: looks right now". A count of
//   items carrying a sentence is not a count of items that are done, and the
//   gap between those two numbers is the whole reason a tracker drifts away
//   from reality while every column stays green.
//
// What it asks
//   One question per finished item: does this evidence establish this claim?
//   A yes means it names something checkable that a second person could go and
//   look at. A no means it asserts, restates the task, or describes an
//   intention. Nothing here is about whether the work is GOOD; only whether
//   the record of it can be trusted.
//
// What it changes
//   Nothing. It reads the tree and reports. The tree stays the one place the
//   work lives, and a verdict about it is not an edit to it.
//
// Usage
//   check-the-evidence-behind-finished-work.mjs --tree <path> --rubrics <path>

import {readFile} from 'node:fs/promises'
import {judge, VerdictRefused} from '../../../../ai-command-center/.claude/hooks/judges/ask-for-a-verdict.mjs'
import {everyNode} from './roll-up-work-completion.mjs'
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ADAPTERS = {
  'locally-served': () => import('../../../../ai-command-center/.claude/hooks/judges/ask-a-locally-served-model.mjs'),
  'hosted-classifier': () => import('../../../../ai-command-center/.claude/hooks/judges/ask-a-hosted-classifier.mjs'),
}

// The question is deliberately narrow: is this evidence CHECKABLE. It is not
// "is the item finished", which the tree already tracks in its own state, and
// it is not "is the work good", which no classifier should be asked.
//
// The first version asked whether the evidence established that the item was
// finished, and the classifier disagreed with a case where the evidence was a
// passing test suite for an item about live behaviour. It was right and the
// case was wrong: a passing test is checkable, and separately it is not proof
// that a person can do the thing. Two questions had been folded into one, so
// every answer had to mean two things at once, and the calibration is what
// surfaced it. That is the calibration doing its job, not failing it.
export const EVIDENCE_RUBRIC = {
  id: 'can-someone-else-go-and-check-this',
  question: 'Does this evidence name something a second person could go and check for themselves?',
  answer_shape: {
    kind: 'true-or-false',
    means: {
      yes: 'It names a specific thing to look at: a command and its result, a count, a file, a measurement, a screen to open, a wall that was hit.',
      no: 'It asserts, restates the task, describes a feeling or an intention, or is too vague to point anyone at anything.',
    },
  },
  say: 'the evidence points at nothing anyone could go and check',
  confidence_bands: [
    {at_least: 0.75, then: 'raise-it'},
    {at_least: 0.45, then: 'look-at-it'},
    {at_least: 0, then: 'accept-it'},
  ],
  band_when_confidence_unknown: 'look-at-it',
  calibration: [
    {content: 'EVIDENCE: 29 tests, 29 pass, 0 fail, in 91ms.', expect: true},
    {content: 'EVIDENCE: feels much faster now', expect: false},
    {
      content: 'EVIDENCE: the install verb is not declared for this agent, so the carrier cannot be installed from here and the running app still shows two icons.',
      expect: true,
    },
    {content: 'EVIDENCE: done', expect: false},
    {
      content: 'EVIDENCE: sent one message through the hosted app and the reply painted in the thread.',
      expect: true,
    },
    {content: 'EVIDENCE: implemented as described in the task', expect: false},
  ],
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  if (!values.get('tree')) throw new Error('usage: check-the-evidence-behind-finished-work.mjs --tree <path> [--rubrics <path>]')
  return {tree: values.get('tree'), rubrics: values.get('rubrics')}
}

export async function main(argv) {
  const {tree: treePath, rubrics: rubricsPath} = readArguments(argv)
  const tree = JSON.parse(await readFile(treePath, 'utf8'))

  // Providers come from the same DATA the turn judge uses, so there is one
  // place that says where a classifier lives.
  let providers = [{via: 'locally-served'}]
  if (rubricsPath) {
    try {
      const settings = JSON.parse(await readFile(rubricsPath, 'utf8'))
      providers = (settings.ask_in_order ?? providers).map(one => (typeof one === 'string' ? {via: one} : one))
    } catch {
      // No provider DATA simply means the default one.
    }
  }

  const asking = []
  for (const provider of providers) {
    const load = ADAPTERS[provider.via]
    if (!load) continue
    try {
      const adapter = await load()
      if (typeof adapter.configure === 'function') adapter.configure(provider)
      for (const candidate of await adapter.candidates(provider)) asking.push({candidate, ask: adapter.ask})
    } catch {
      // A provider that cannot say what it offers is simply not offering.
    }
  }
  if (asking.length === 0) {
    process.stdout.write('Nothing is available to ask, so no evidence was checked.\n')
    return 1
  }
  const ask = args => asking.find(one => one.candidate.name === args.candidate.name).ask(args)
  const candidates = asking.map(one => one.candidate)

  const finished = []
  for (const node of everyNode(tree)) {
    if (!Array.isArray(node.children) && node.state === 'done' && node.verified_by) {
      finished.push(node)
    }
  }

  const doubted = []
  const looked = []
  for (const item of finished) {
    const content = `ITEM: ${item.title}\nEVIDENCE: ${item.verified_by}`
    try {
      const verdict = await judge({rubric: EVIDENCE_RUBRIC, content, candidates, ask, passes: 1})
      // The rubric asks whether the evidence HOLDS. A false answer is the
      // finding, so the band is read against the answer rather than alone.
      const row = {id: item.id, title: item.title, holds: verdict.answer, confidence: verdict.confidence}
      if (verdict.answer === false) doubted.push(row)
      else looked.push(row)
    } catch (error) {
      doubted.push({
        id: item.id,
        title: item.title,
        holds: null,
        why: error instanceof VerdictRefused ? error.message : `could not ask: ${error.message}`,
      })
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        finished_items: finished.length,
        evidence_holds: looked.length,
        evidence_does_not_hold: doubted.length,
        // The number that matters. A tracker is only worth what its finished
        // column is worth, and this is how much of that column survives being
        // read.
        trustworthy_share: finished.length === 0 ? 0 : Math.round((looked.length / finished.length) * 1000) / 10,
        look_at_these: doubted,
      },
      null,
      2,
    ) + '\n',
  )
  return 0
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    },
  )
}
