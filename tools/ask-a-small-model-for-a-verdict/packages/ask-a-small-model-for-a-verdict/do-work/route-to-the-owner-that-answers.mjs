#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/route-to-the-owner-that-answers.mjs
//
// Given something you are looking for, pick the owner that actually knows.
//
// Why this is the highest-value decision to hand over
//   Writing the code is rarely the slow part. Finding out WHERE the answer
//   lives is. The expensive failure has one shape every time: look in one
//   place, under the name you happen to be using, find nothing, and conclude
//   the thing does not exist. That conclusion reads like a finding, it is
//   confident and specific, and it is wrong. Each one costs minutes to hours,
//   and the cost is paid again by the next person who repeats it.
//
//   A classifier cannot write the answer. It can pick, from a list of owners
//   it was handed, the one most likely to hold it, with a probability. That is
//   a smaller job than reasoning, which is exactly why it takes 200ms instead
//   of a search, and why it cannot invent an owner that does not exist.
//
// What makes this safe
//   The owner list is DATA. The classifier chooses among owners that were
//   declared, so its worst failure is picking the second-best place to look,
//   which costs one lookup. Compare that to the failure it replaces: asserting
//   absence, which costs everything downstream that believes it.
//
// Why the whole spread comes back
//   A route is not a commitment. When two owners are close, the right move is
//   to look in both, and that is only possible if the losing options survived.
//   A single answer would throw away the thing that makes this cheap.
//
// Usage
//   route-to-the-owner-that-answers.mjs --owners <path> --looking-for "<text>"
//     [--rubrics <path>]

import {readFile} from 'node:fs/promises'
import {judge} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ADAPTERS = {
  'locally-served': () => import('../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-a-locally-served-model.mjs'),
  'hosted-classifier': () => import('../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-a-hosted-classifier.mjs'),
}

/** Build the question from the owner map, so adding an owner is a DATA row. */
export function rubricFor(owners) {
  return {
    id: 'which-owner-holds-this',
    // Nine options means chance is about one in nine, so a classifier that gets
    // nine in ten right is doing real work. Demanding every case, which is the
    // correct bar for a yes/no question, refused one that scored 26 of 27.
    pass_when_share_correct: 0.9,
    question: 'Which of these owners holds the answer to what is being looked for?',
    answer_shape: {
      kind: 'one-of',
      options: owners.map(one => ({name: one.id, description: one.holds})),
    },
    confidence_bands: [
      {at_least: 0.6, then: 'go-there'},
      {at_least: 0.3, then: 'look-in-the-top-two'},
      {at_least: 0, then: 'no-clear-owner'},
    ],
    band_when_confidence_unknown: 'look-in-the-top-two',
    calibration: owners.flatMap(one => (one.for_example ?? []).map(text => ({content: text, expect: one.id}))),
  }
}

export async function classifiersFrom(rubricsPath) {
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
  return {
    candidates: asking.map(one => one.candidate),
    ask: args => asking.find(one => one.candidate.name === args.candidate.name).ask(args),
  }
}

export async function route({owners, lookingFor, candidates, ask, remember = null}) {
  const verdict = await judge({rubric: rubricFor(owners), content: lookingFor, candidates, ask, passes: 1, remember})
  const ranked = (verdict.distribution ?? [])
    .slice()
    .sort((left, right) => right.probability - left.probability)
    .slice(0, 3)
    .map(one => ({owner: one.option, probability: one.probability, how: owners.find(o => o.id === one.option)?.ask}))
  return {
    looking_for: lookingFor,
    go_to: verdict.answer,
    confidence: verdict.confidence,
    what_to_do: verdict.band,
    how: owners.find(one => one.id === verdict.answer)?.ask ?? null,
    // Kept so a close second is still reachable. A route is a suggestion about
    // where to look, never a claim about what is there.
    then_try: ranked.slice(1),
  }
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  if (!values.get('owners') || !values.get('looking-for')) {
    throw new Error('usage: route-to-the-owner-that-answers.mjs --owners <path> --looking-for "<text>" [--rubrics <path>]')
  }
  return {owners: values.get('owners'), lookingFor: values.get('looking-for'), rubrics: values.get('rubrics')}
}

export async function main(argv) {
  const {owners: ownersPath, lookingFor, rubrics} = readArguments(argv)
  const owners = JSON.parse(await readFile(ownersPath, 'utf8')).owners
  const {candidates, ask} = await classifiersFrom(rubrics)
  if (candidates.length === 0) {
    process.stdout.write('Nothing is available to ask, so nothing was routed.\n')
    return 1
  }
  process.stdout.write(JSON.stringify(await route({owners, lookingFor, candidates, ask}), null, 2) + '\n')
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
