// Learning from everyone's results without any one person's result being readable, even to this service.
//
// What a person's store sends: for a decision that is shared, one bit ("did it work?") after randomized
// response in their own store (it reports the truth with probability e^ε/(1+e^ε), the opposite otherwise), under a
// contributor id that is random, kept only in their store, and never linked to their account. The pool therefore
// never holds a clean result, and a server bug that leaks the pool leaks only noise.
//
// What the pool answers, computed when someone asks and never in the background (nothing runs while nobody asks):
//   1. one vote per contributor, so one person sending a thousand results counts once;
//   2. nothing at all under a minimum number of distinct people (the rule under the noise, never the only guard);
//   3. the median across contributor shards of each shard's mean, so a minority of shards filled with poisoned
//      results cannot move the answer (a plain average fails with one attacker);
//   4. the randomized response undone, then noise added that is fixed by the question and the pool's version, so
//      asking the same question again returns the same answer and cannot be averaged away;
//   5. counts rounded to buckets, so a single join or withdrawal is not visible as a step of one.
// Withdrawal deletes a contributor's rows and bumps only their shard's version; the next answer recomputes from
// what is left.
//
// Automatic promotion: a choice point (for example which model rewrites shared decisions) names a control and
// candidates as DATA. Each use is assigned an arm by a hash of its subject; outcomes are counted with no person or
// content. A candidate replaces the control only when its gain clears a threshold that assumes most candidates are
// noise, and its guardrail rate is no worse than the control's by more than the declared margin.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export const contributorIdentity = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
// The first four bytes of the text's BLAKE3, read as a fraction in [0, 1).
const hashUnit = text => Number.parseInt(contributorIdentity(text).slice(3, 11), 16) / 2 ** 32;

/** The probability randomized response reports the truth, for privacy loss ε. */
export const truthProbability = epsilon => Math.exp(epsilon) / (1 + Math.exp(epsilon));

/** Run in the person's own store: the one bit that may leave it. `random` is a uniform draw in [0, 1). */
export function randomizedResponse(worked, epsilon, random = Math.random()) {
  return random < truthProbability(epsilon) ? Boolean(worked) : !worked;
}

/** The share that worked, recovered from the share of noisy "worked" reports. */
export function debias(reportedShare, epsilon) {
  const p = truthProbability(epsilon);
  return Math.min(1, Math.max(0, (reportedShare - (1 - p)) / (2 * p - 1)));
}

export const shardOf = (contributor, shards) => Math.floor(hashUnit(`shard|${contributor}`) * shards);

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Laplace noise drawn deterministically from a seed: the same question over the same pool gets the same noise. */
export function seededLaplace(seed, scale) {
  const u = hashUnit(`noise|${seed}`) - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/**
 * rows: [{ contributor, shard, worked }] (worked is the noisy bit as the person's store sent it)
 * rules: { epsilon, min_people, shards, query_epsilon, people_bucket, share_step }
 * → { enough: false, people_at_least } or { enough: true, people_at_least, worked_share }
 */
export function aggregateOnRead(rows, rules, { question, version }) {
  const votes = new Map();
  for (const row of rows) {
    const vote = votes.get(row.contributor) ?? { shard: row.shard, worked: 0, total: 0 };
    vote.worked += row.worked ? 1 : 0;
    vote.total += 1;
    votes.set(row.contributor, vote);
  }
  const people = votes.size;
  const peopleAtLeast = Math.floor(people / rules.people_bucket) * rules.people_bucket;
  if (people < rules.min_people) return { enough: false, people_at_least: peopleAtLeast };
  const shards = new Map();
  for (const vote of votes.values()) {
    const shard = shards.get(vote.shard) ?? [];
    shard.push(vote.worked / vote.total);
    shards.set(vote.shard, shard);
  }
  const robust = median([...shards.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length));
  const noisy = debias(robust, rules.epsilon) + seededLaplace(`${question}|${version}`, 1 / (people * rules.query_epsilon));
  const share = Math.min(1, Math.max(0, Math.round(noisy / rules.share_step) * rules.share_step));
  return { enough: true, people_at_least: peopleAtLeast, worked_share: Math.round(share * 100) / 100 };
}

/** The arm a subject uses at a choice point: fixed by a hash of the subject, so a retry lands on the same arm. */
export function armFor(choice, subject) {
  const arms = [choice.control, ...(choice.candidates ?? [])];
  return arms[Math.floor(hashUnit(`arm|${choice.id}|${subject}`) * arms.length)];
}

/**
 * The arm in use now. counts: { [arm]: { trials, successes, guardrail_hits } }.
 * A candidate is promoted when its success rate beats the control's with z ≥ choice.promote_at_z (a high bar,
 * because most candidates are noise), it has at least choice.min_trials, and its guardrail rate is no more than
 * choice.guardrail_margin above the control's. The best such candidate wins; otherwise the control stays.
 */
export function promotedArm(choice, counts) {
  const rate = (arm, field) => (counts[arm]?.trials ? counts[arm][field] / counts[arm].trials : 0);
  const control = counts[choice.control] ?? { trials: 0, successes: 0, guardrail_hits: 0 };
  let best = { arm: choice.control, z: 0 };
  for (const arm of choice.candidates ?? []) {
    const trial = counts[arm];
    if (!trial || trial.trials < choice.min_trials || control.trials < choice.min_trials) continue;
    const p1 = rate(arm, 'successes');
    const p0 = rate(choice.control, 'successes');
    const pooled = (trial.successes + control.successes) / (trial.trials + control.trials);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / trial.trials + 1 / control.trials));
    const z = se ? (p1 - p0) / se : 0;
    const guardrailHolds = rate(arm, 'guardrail_hits') <= rate(choice.control, 'guardrail_hits') + choice.guardrail_margin;
    // Revenue per trial breaks a tie between arms that clear the bar equally.
    const revenue = trial.trials ? (trial.revenue_cents ?? 0) / trial.trials : 0;
    if (z >= choice.promote_at_z && guardrailHolds && (z > best.z || (z === best.z && revenue > (best.revenue ?? 0)))) best = { arm, z, revenue };
  }
  return best.arm;
}
