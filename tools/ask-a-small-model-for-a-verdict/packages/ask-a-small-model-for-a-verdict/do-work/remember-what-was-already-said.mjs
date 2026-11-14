#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/remember-what-was-already-said.mjs
//
// Keep track of which corrections have already been given, so the same one is
// not delivered forever in the same words.
//
// The failure this exists for
//   A check that fires, says its piece, and forgets is not a correction. It is
//   a weather report. Measured on this machine before this file existed: forty
//   four verdicts recorded, forty three of them repeats of a verdict already
//   given, one shape delivered six separate times in identical wording. Nothing
//   read the log. Nothing counted. The seventh delivery would have looked
//   exactly like the first.
//
//   Repetition is not a reason to say it louder. It is evidence that saying it
//   does not work, and that whatever would actually prevent it has not been
//   built. So the count is the message: the first time, here is what does not
//   hold up; the sixth time, this has been said six times and the words are
//   clearly not the fix.
//
// Why the excerpt has to be stored
//   The log used to record how many characters were judged and not one of them.
//   That made memory impossible at the root: you cannot cluster mistakes you
//   never wrote down. A reader built on top of that log could only ever count
//   how often a rubric fired, never whether it was firing about the same thing.
//
// How two occurrences are decided to be the same
//   By asking, not by matching strings. The same mistake almost never arrives
//   in the same words, so a string comparison reports everything as new and the
//   count never rises. Picking which remembered shape a new one belongs to, or
//   none of them, is a closed choice over a list, which is the one question a
//   classifier answers well and cheaply. It cannot invent a shape that is not
//   already in the list, so its worst failure is filing something under a
//   neighbour, which costs an inflated count on one shape and a missing one on
//   another. Compare that with the current behaviour, which is no memory at all.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {judge} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'

/** How much of the offending text to keep. Enough to recognise, not a transcript. */
export const KEEP_CHARACTERS = 600

/** Shown as an option, so it must stay short enough that many fit one question. */
const AS_OPTION = 300

/** Beyond this many remembered shapes the oldest quiet ones stop being offered. */
const MOST_SHAPES = 40

export function readMemory(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(held?.shapes) ? held : {shapes: []}
  } catch {
    return {shapes: []}
  }
}

export function writeMemory(path, memory) {
  try {
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, JSON.stringify(memory, null, 2))
  } catch {
    // Memory that cannot be written must not take the turn down with it.
  }
}

/** Only shapes from the same rubric can be the same mistake. */
export function shapesFor(memory, rubricId) {
  return memory.shapes
    .filter(one => one.rubric_id === rubricId)
    .sort((left, right) => (right.times ?? 0) - (left.times ?? 0))
    .slice(0, MOST_SHAPES)
}

const NEW_ONE = 'a-mistake-not-in-this-list'

export function rubricForMatching(shapes) {
  return {
    id: 'which-remembered-mistake-is-this',
    // Chance on a list of n is one in n, and these options are excerpts rather
    // than clean categories, so demanding every case would refuse a classifier
    // that is doing real work. Calibration comes from the shapes themselves.
    pass_when_share_correct: 0.8,
    question: 'The text below is a turn that was just flagged. Which of these earlier flagged turns is it the same kind of mistake as?',
    answer_shape: {
      kind: 'one-of',
      options: [
        ...shapes.map(one => ({name: one.id, description: one.example.slice(0, AS_OPTION)})),
        {name: NEW_ONE, description: 'None of the above. This is a different kind of mistake from every one listed.'},
      ],
    },
    confidence_bands: [
      {at_least: 0.55, then: 'same-as-that-one'},
      {at_least: 0, then: 'treat-as-new'},
    ],
    band_when_confidence_unknown: 'treat-as-new',
    // Each remembered shape vouches for itself: its own stored example must be
    // filed back under it. A shape that cannot recognise its own text is not a
    // shape anyone should be counting.
    calibration: shapes.map(one => ({content: one.example, expect: one.id})),
  }
}

const words = text => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])

/** How much two excerpts overlap, 0 to 1. */
export function overlap(left, right) {
  const one = words(left)
  const other = words(right)
  if (one.size === 0 || other.size === 0) return 0
  let shared = 0
  for (const word of one) if (other.has(word)) shared += 1
  return shared / (one.size + other.size - shared)
}

/** Above this, the two are plainly the same text and nothing needs asking. */
export const PLAINLY_THE_SAME = 0.8

/**
 * Decide which remembered shape this belongs to, or that it is new.
 * Returns the shape id, or null meaning new.
 *
 * Settle the obvious case without asking anyone. A classifier is for the hard
 * half of this job, the same mistake arriving in different words. Handing it
 * near-identical text is both a waste and actively harmful: duplicates pile up
 * as separate shapes, the question becomes "which of these five identical
 * excerpts is this one", and that has no correct answer. Measured before this
 * guard existed, that exact question was put to two classifiers and scored 1/5
 * and 0/5 against a 1/6 chance, so the rubric refused. The refusal was right,
 * and the fallback from a refusal is to record a new shape, which added another
 * duplicate and made the next question worse. Duplicates were feeding on
 * themselves.
 */
export async function whichShape({excerpt, shapes, candidates, ask}) {
  if (shapes.length === 0) return null

  let closest = null
  let best = 0
  for (const shape of shapes) {
    const score = overlap(excerpt, shape.example)
    if (score > best) {
      best = score
      closest = shape
    }
  }
  if (best >= PLAINLY_THE_SAME) return closest.id

  try {
    const verdict = await judge({rubric: rubricForMatching(shapes), content: excerpt, candidates, ask, passes: 1})
    if (verdict.band !== 'same-as-that-one') return null
    return verdict.answer === NEW_ONE ? null : verdict.answer
  } catch {
    // Unable to ask means unable to claim it is a repeat. Treating an unmatched
    // turn as new overcounts shapes; treating a new one as a repeat would
    // inflate a count that is about to be used as an argument. Overcount the
    // cheaper way.
    return null
  }
}

/** Record that this happened, and return the shape as it now stands. */
export function noteIt({memory, rubricId, excerpt, shapeId, session, at}) {
  const found = shapeId ? memory.shapes.find(one => one.id === shapeId) : null
  if (found) {
    found.times = (found.times ?? 0) + 1
    found.last_seen = at
    if (session && !found.sessions.includes(session)) found.sessions.push(session)
    return found
  }
  const made = {
    id: `${rubricId}-${memory.shapes.length + 1}`,
    rubric_id: rubricId,
    example: excerpt.slice(0, KEEP_CHARACTERS),
    times: 1,
    sessions: session ? [session] : [],
    first_seen: at,
    last_seen: at,
  }
  memory.shapes.push(made)
  return made
}

/**
 * What to actually say, given how often this has been said before.
 *
 * The escalation is not about volume. Each step hands over a different fact,
 * and the last one stops asking the turn to try harder, because by then trying
 * harder has demonstrably not worked.
 */
export function whatToSay(say, shape) {
  const times = shape.times ?? 1
  const across = shape.sessions?.length ?? 1
  if (times <= 1) return say
  if (times < 4) {
    return `${say}\n    (the same thing was flagged here ${times} times now)`
  }
  return (
    `${say}\n` +
    `    This has now been flagged ${times} times` +
    (across > 1 ? ` across ${across} separate sessions` : '') +
    `, in the same shape each time.\n` +
    `    Saying it again is not going to be what fixes it. Something structural is missing:\n` +
    `    a guard that makes this impossible, a default that removes the choice, or a\n` +
    `    capability that is absent so the wrong road keeps being the only open one.\n` +
    `    First seen ${shape.first_seen}. Build that instead of re-reading this line.`
  )
}

/** Everything remembered, most repeated first. For looking at directly. */
export function report(memory) {
  return memory.shapes
    .slice()
    .sort((left, right) => (right.times ?? 0) - (left.times ?? 0))
    .map(one => ({
      id: one.id,
      times: one.times,
      sessions: one.sessions?.length ?? 0,
      first_seen: one.first_seen,
      last_seen: one.last_seen,
      example: one.example.slice(0, 160),
    }))
}

export async function main(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  const path = values.get('memory')
  if (!path) throw new Error('usage: remember-what-was-already-said.mjs --memory <path>')
  process.stdout.write(JSON.stringify(report(readMemory(path)), null, 2) + '\n')
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
