//
// Given something you are looking for, pick the owner that actually knows.
//
// A classifier cannot write the answer. It can pick, from a list of owners it
// was handed, the one most likely to hold it, with a probability. That is a
// smaller job than reasoning, and it cannot invent an owner that does not
// exist, so its worst failure is naming the second-best place to look, which
// costs one lookup, instead of asserting that nothing exists.
//
// The owner list is the person's data: {id, holds, ask?, for_example?[]}. Each
// owner's examples are the calibration cases: a model has to file at least the
// share of them the person set (pass_when_share_correct) back under the right
// owner before it is used. A share below 1 lets that fraction of mis-filed
// examples through, so the bar is the person's call and is always in the
// request. The whole spread comes back, so when two owners are close both can
// be tried. The confidence bands (what to do at which confidence) are the
// person's too.

import {VerdictRefused, judge} from './ask-for-a-verdict.mjs'

/** The settings a route needs from the person, each checked; nothing is assumed. */
export function readSettings({pass_when_share_correct: passWhen, confidence_bands: bands, band_when_confidence_unknown: whenUnknown} = {}) {
  if (typeof passWhen !== 'number' || !(passWhen > 0 && passWhen <= 1)) {
    throw new VerdictRefused('pass_when_share_correct is required: the share of the owners\' own examples a model must file back under the right owner, above 0 and at most 1')
  }
  const ok = Array.isArray(bands) && bands.length > 0 &&
    bands.every(one => typeof one?.at_least === 'number' && typeof one?.then === 'string' && one.then !== '')
  if (!ok) {
    throw new VerdictRefused('confidence_bands is required: [{at_least: 0..1, then: what to do}], for example one band for "go there" and one for "look in the top two"')
  }
  if (typeof whenUnknown !== 'string' || whenUnknown === '') {
    throw new VerdictRefused('band_when_confidence_unknown is required: what to do when a model gives an answer with no probability')
  }
  return {pass_when_share_correct: passWhen, confidence_bands: bands, band_when_confidence_unknown: whenUnknown}
}

/** Build the question from the owner map, so adding an owner is a DATA row. */
export function rubricFor(owners, settings) {
  return {
    id: 'which-owner-holds-this',
    ...readSettings(settings),
    question: 'Which of these owners holds the answer to what is being looked for?',
    answer_shape: {
      kind: 'one-of',
      options: owners.map(one => ({name: one.id, description: one.holds})),
    },
    calibration: owners.flatMap(one => (one.for_example ?? []).map(text => ({content: text, expect: one.id}))),
  }
}

export async function route({owners, lookingFor, settings, candidates, ask, remember = null}) {
  const verdict = await judge({rubric: rubricFor(owners, settings), content: lookingFor, candidates, ask, passes: 1, remember})
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
