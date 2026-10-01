// tools/ask-questions-sort-answers-follow-up/do-work/score-answers-and-pick-a-segment.mjs
//
// The Workshop tool "Score a person's answers and pick their segment and follow-up". argv[2] is one JSON input:
//   { answers: { <questionId>: value },
//     score_rules: [{ readKey, points?, match: { value_map? | equals? | gte? | lte? | min_length? | has_value? | contains? }, scoreLabel? }],
//     segment_rules: [{ min, segmentId, title?, meaning?, nextStep? }],
//     follow_ups?: [{ segmentId, steps: [{ stepId, label?, delayHours?, bodyTemplate?, venueConfigAddress? }] }] }
// Every weight, threshold and follow-up is the caller's DATA. Prints one JSON line: the score, what each answer
// added, subtotals by label, the segment with its title, meaning and next step, and that segment's follow-up.
import { decide } from '../read-data/score-and-segment.ts';
import { readFollowUpSequences, selectFollowUpSequence } from '../read-data/follow-up-sequences.ts';

export function scoreAnswersAndPickASegment(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const problems = [];
  if (!object(input) || !object(input.answers)) problems.push('answers must be an object of question id to answer');
  const scoreRules = Array.isArray(input?.score_rules) ? input.score_rules : [];
  const segmentRules = Array.isArray(input?.segment_rules) ? input.segment_rules : [];
  if (!scoreRules.length) problems.push('score_rules must list how answers earn points');
  scoreRules.forEach((rule, index) => { if (!object(rule) || typeof rule.readKey !== 'string' || !object(rule.match)) problems.push(`score_rules[${index}] needs readKey and match`); });
  if (!segmentRules.length) problems.push('segment_rules must list the segments and the score each starts at');
  segmentRules.forEach((rule, index) => { if (!object(rule) || typeof rule.segmentId !== 'string' || !Number.isFinite(rule.min)) problems.push(`segment_rules[${index}] needs segmentId and min`); });
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const decided = decide(input.answers, scoreRules, segmentRules);
  const segment = segmentRules.find(rule => rule.segmentId === decided.segmentId) ?? null;
  const followUps = readFollowUpSequences((Array.isArray(input.follow_ups) ? input.follow_ups : []).map(row => ({ kind: 'follow-up-sequence', ...row })));
  return {
    score: decided.score, breakdown: decided.breakdown, by_label: decided.byLabel,
    segment: segment ? { segmentId: segment.segmentId, title: segment.title ?? null, meaning: segment.meaning ?? null, next_step: segment.nextStep ?? null } : null,
    follow_up: selectFollowUpSequence(decided.segmentId, followUps)?.steps ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(scoreAnswersAndPickASegment(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
