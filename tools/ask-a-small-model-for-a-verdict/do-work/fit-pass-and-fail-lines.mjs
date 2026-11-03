// tools/ask-a-small-model-for-a-verdict/do-work/fit-pass-and-fail-lines.mjs
//
// Two lines on a model's probability of the failing answer, fitted from lines a person already ruled on, and whether
// the question is usable at all. find-lines draws one line between right answers; this draws two, so a verdict can be
// pass, fail or uncertain in between:
//
//   t_fail  fails at most `fail_good_share_at_most` of the good lines (the good lines' upper quantile)
//   t_pass  lets through at most `pass_bad_share_at_most` of the bad lines (the bad lines' lower quantile), never above t_fail
//
// A question is usable only when every bar in `usable_when` holds: AUC, the number of bad lines, the share of bad
// lines failed at t_fail, and the share of good lines failed or left uncertain. The good-line shares are held out:
// each good line is judged against lines fitted without it (leave one out). Recall on the bad lines is already held
// out, since t_fail is fitted on good lines only.
//
// The scores are the caller's: one probability of the failing answer per line, or one per sentence of the line (the
// line's score is then its highest sentence), or null where the model gave no answer. Which model answered, and on
// which lines, is the caller's; lines a model was trained on must never be the lines that calibrate it.
//
//   fitLines({ bad, good, fail_good_share_at_most, pass_bad_share_at_most, usable_when }) -> finding

import {VerdictRefused} from './ask-for-a-verdict.mjs'

/** The sentences of a text, each with its closing punctuation; the whole text when there is no sentence break. */
export function sentences(text) {
  const found = [...String(text).matchAll(/[^.!?]+(?:[.!?]+["'”)]*|$)/g)].map(match => match[0].trim()).filter(Boolean)
  return found.length ? found : [text]
}

/** The chance a bad line scores above a good one, ties counting half. */
export function auc(bad, good) {
  let sum = 0
  for (const p of bad) for (const n of good) sum += (p > n) + 0.5 * (p === n)
  return sum / (bad.length * good.length)
}

/** The value at share `q` of the sorted list, by index (no interpolation). */
export function quantile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]
}

const share = (value, what) => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new VerdictRefused(`${what} is required: a share from 0 to 1`)
  return value
}

/** A line's score: a probability, the highest of its sentences' probabilities, or null when none was answered. */
function scoreOf(line, index, side) {
  const each = Array.isArray(line) ? line : [line]
  const answered = each.filter(value => value !== null && value !== undefined)
  for (const value of answered) {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      throw new VerdictRefused(`${side}[${index}] must be a probability from 0 to 1, a list of them (one per sentence), or null`)
    }
  }
  return answered.length ? Math.max(...answered) : null
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places

export function fitLines({bad, good, fail_good_share_at_most, pass_bad_share_at_most, usable_when} = {}) {
  if (!Array.isArray(bad) || !Array.isArray(good)) {
    throw new VerdictRefused('bad and good are required: the model\'s probability of the failing answer for each line ruled bad and each line ruled good')
  }
  const fpr = share(fail_good_share_at_most, 'fail_good_share_at_most')
  const passBad = share(pass_bad_share_at_most, 'pass_bad_share_at_most')
  const bar = usable_when ?? {}
  const needAuc = share(bar.auc_at_least, 'usable_when.auc_at_least')
  const needRecall = share(bar.recall_at_least, 'usable_when.recall_at_least')
  const mostLoose = share(bar.good_failed_or_uncertain_at_most, 'usable_when.good_failed_or_uncertain_at_most')
  if (!Number.isInteger(bar.bad_lines_at_least) || bar.bad_lines_at_least < 2) {
    throw new VerdictRefused('usable_when.bad_lines_at_least is required: how many answered bad lines a usable question needs (2 or more)')
  }

  const pos = bad.map((line, index) => scoreOf(line, index, 'bad')).filter(value => value !== null)
  const neg = good.map((line, index) => scoreOf(line, index, 'good')).filter(value => value !== null)
  if (pos.length < 2 || !neg.length) {
    return {status: 'unseparable', reason: `only ${pos.length} bad lines and ${neg.length} good lines with answers`}
  }

  // The 1e-6 keeps the good line at the quantile itself on the passing side of t_fail.
  const lines = (badScores, goodScores) => {
    const tFail = quantile(goodScores, 1 - fpr) + 1e-6
    return {tPass: Math.min(quantile(badScores, passBad), tFail), tFail}
  }
  const {tPass, tFail} = lines(pos, neg)
  const area = auc(pos, neg)
  const recall = pos.filter(p => p >= tFail).length / pos.length
  const heldOut = neg.length > 1 ? neg.map((_, index) => lines(pos, neg.filter((__, other) => other !== index))) : [{tPass, tFail}]
  const goodFailed = neg.filter((p, index) => p >= heldOut[index].tFail).length / neg.length
  const loose = neg.filter((p, index) => p >= heldOut[index].tPass).length / neg.length

  const why = [
    [`AUC ${area.toFixed(2)} < ${needAuc}`, area < needAuc],
    [`only ${pos.length} bad lines`, pos.length < bar.bad_lines_at_least],
    [`recall ${recall.toFixed(2)} < ${needRecall}`, recall < needRecall],
    [`${Math.round(loose * 100)}% of good lines fail or escalate`, loose > mostLoose],
  ].filter(([, failed]) => failed).map(([words]) => words)

  return {
    status: why.length ? 'unseparable' : 'usable',
    auc: round(area, 3), n_bad: pos.length, n_good: neg.length, fail_good_share_at_most: fpr,
    t_pass: round(tPass, 4), t_fail: round(tFail, 4), recall: round(recall, 3),
    good_failed_held_out: round(goodFailed, 3), good_failed_or_uncertain_held_out: round(loose, 3),
    ...(why.length ? {reason: why.join('; ')} : {}),
  }
}
