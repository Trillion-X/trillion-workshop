// Keep count of how often the same kind of thing has been flagged, so a repeat
// is recognised as a repeat and the count, not the wording, is what is said.
//
// Two flagged texts are the same kind by asking, not by matching strings: the
// same mistake almost never arrives in the same words, so a string comparison
// reports everything as new and the count never rises. Picking which
// remembered shape a new text belongs to, or none of them, is a closed choice
// over a list, which a small model answers well and cannot answer with a shape
// that is not on the list. Its worst failure is filing something under a
// neighbour. Nearly identical texts are settled first by word overlap without
// asking anyone, since a model handed five identical options has no right
// answer and duplicates would feed on themselves.
//
// The excerpt has to be stored: you cannot cluster what you never wrote down.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {VerdictRefused, judge} from './ask-for-a-verdict.mjs'

/**
 * A whole number of characters the person chose, above zero. How much of a
 * flagged text to keep is theirs to say: enough to recognise, not a transcript.
 */
export function readCharacters(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new VerdictRefused(`${name} is required: a whole number of characters above zero`)
  }
  return value
}

/** A number above 0 and at most 1, the person's own bar. */
export function readShare(value, name, what) {
  if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
    throw new VerdictRefused(`${name} is required: ${what}, above 0 and at most 1`)
  }
  return value
}

/**
 * The bars for recognising a repeat, each the person's. `asking` is false when
 * no model will be asked, so the two bars that only a model uses are not demanded.
 */
export function readMatching(request, {asking}) {
  const matching = {
    plainly_the_same_at: readShare(request.plainly_the_same_at, 'plainly_the_same_at', 'the word overlap at which two texts are the same without asking anyone'),
  }
  if (asking) {
    matching.pass_when_share_correct = readShare(request.pass_when_share_correct, 'pass_when_share_correct', 'the share of the earlier flags a model must file back under themselves before it is trusted')
    matching.same_at_least = readShare(request.same_at_least, 'same_at_least', 'the confidence at which a model\'s pick counts as the same kind')
  }
  return matching
}

/**
 * Shown as an option, so it must stay short enough that many fit one question.
 * A model's question has room for only so many options: this and MOST_SHAPES
 * bound the size of one prompt, which is a limit of the model's reading window
 * rather than a preference, so they are not settings.
 */
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
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, JSON.stringify(memory, null, 2))
}

/** Only shapes from the same rubric can be the same kind of thing. */
export function shapesFor(memory, rubricId) {
  return memory.shapes
    .filter(one => one.rubric_id === rubricId)
    .sort((left, right) => (right.times ?? 0) - (left.times ?? 0))
    .slice(0, MOST_SHAPES)
}

const NEW_ONE = 'not-in-this-list'

export function rubricForMatching(shapes, {pass_when_share_correct: passWhen, same_at_least: sameAt}) {
  return {
    id: 'which-remembered-shape-is-this',
    // Chance on a list of n is one in n, and these options are excerpts rather
    // than clean categories, so demanding every case may refuse a classifier
    // that is doing real work. The bar is the person's. Calibration comes from
    // the shapes themselves.
    pass_when_share_correct: passWhen,
    question: 'The text below was just flagged. Which of these earlier flagged texts is it the same kind of thing as?',
    answer_shape: {
      kind: 'one-of',
      options: [
        ...shapes.map(one => ({name: one.id, description: one.example.slice(0, AS_OPTION)})),
        {name: NEW_ONE, description: 'None of the above. This is a different kind of thing from every one listed.'},
      ],
    },
    confidence_bands: [
      {at_least: sameAt, then: 'same-as-that-one'},
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

/**
 * Decide which remembered shape this belongs to, or that it is new.
 * Returns the shape id, or null meaning new. `matching` is the person's bars
 * (see readMatching); at or above `plainly_the_same_at` overlap the two are the
 * same text and nothing is asked.
 */
export async function whichShape({excerpt, shapes, matching, candidates, ask}) {
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
  if (best >= matching.plainly_the_same_at) return closest.id
  if (!ask) return null

  try {
    const verdict = await judge({rubric: rubricForMatching(shapes, matching), content: excerpt, candidates, ask, passes: 1})
    if (verdict.band !== 'same-as-that-one') return null
    return verdict.answer === NEW_ONE ? null : verdict.answer
  } catch {
    // Unable to ask means unable to claim it is a repeat. Treating an unmatched
    // text as new overcounts shapes; treating a new one as a repeat would
    // inflate a count that is about to be used as an argument. Overcount the
    // cheaper way.
    return null
  }
}

/** Record that this happened, and return the shape as it now stands. */
export function noteIt({memory, rubricId, excerpt, keepCharacters, shapeId, session, at}) {
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
    example: excerpt.slice(0, keepCharacters),
    times: 1,
    sessions: session ? [session] : [],
    first_seen: at,
    last_seen: at,
  }
  memory.shapes.push(made)
  return made
}

/** Everything remembered, most repeated first. */
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
