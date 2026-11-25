// tools/ask-questions-sort-answers-follow-up/read-data/answers-over-time.mjs
//
// PURPOSE
//   One person's answers to one form over every time they sat it, and everyone's latest standing, read from the rows the
//   form tools keep: answer facts (one per answered question per sitting), segment assignments (one per sitting), the form's
//   segment rules and follow-up sequences. `answersOverTime` is what a person reads about themselves: each sitting in order
//   with its segment, each question as a series of answers (one series per question and per thing it was about), what changed
//   between the last two sittings, and the follow-up of the segment they are in now. `latestStandingOf` is what the form's
//   owner reads about everyone: how many people stand in each segment now, and each person's latest segment, the one before
//   it, and which way they moved.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and browser-safe: rows in, a model out. Nothing here reads a door, a database or a clock.
//   2. No question type, segment, tier or word is named here: segments and their order are the segment rules (a higher `min`
//      ranks higher), a series is numeric only when every answer in it is a number, and every word a screen draws is its own.
//   3. A sitting is one submission (`submissionId`); facts with none are one sitting. The latest answer to a question within a
//      sitting wins (foldAnswerFacts).
//   4. A series is one question about one thing: a question asked `about` an earlier answer (the stroke picked) keeps one
//      series per thing, so a different stroke is never read as a changed answer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { foldAnswerFacts } from './fold-answer-facts.ts';
import { answerText } from './question-descriptor.ts';

const valueOf = row => (row && typeof row === 'object' && 'value' in row && row.value && typeof row.value === 'object' ? row.value : row);
const text = value => (typeof value === 'string' && value ? value : null);
const aboutKey = about => (about && typeof about === 'object' ? Object.entries(about).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&') : '');

/** The form's segments in rank order (lowest `min` first), each with its title, meaning, next step and rank. */
export function segmentsOf(segmentRules = []) {
  return segmentRules.map(valueOf).filter(rule => rule && typeof rule.segmentId === 'string' && typeof rule.min === 'number')
    .sort((a, b) => a.min - b.min)
    .map((rule, rank) => ({ id: rule.segmentId, title: text(rule.title) ?? rule.segmentId, meaning: text(rule.meaning), next_step: text(rule.nextStep), rank }));
}

const segmentOf = (segments, id) => (id ? segments.find(segment => segment.id === id) ?? { id, title: id, meaning: null, next_step: null, rank: null } : null);

/** Which way a person moved between two segments: up, down, same, or null when either has no rank. */
export function directionOf(before, after) {
  if (!before || !after || before.rank === null || after.rank === null) return null;
  return after.rank > before.rank ? 'up' : after.rank < before.rank ? 'down' : 'same';
}

/**
 * One person's sittings of one form.
 * form: the question-sequence value ({ formId, questions }). facts, assignments, segmentRules, followUps: kept rows or their
 * values. respondentId: whose sittings.
 */
export function answersOverTime({ form, facts = [], assignments = [], segmentRules = [], followUps = [], respondentId }) {
  const formId = form?.formId;
  const questions = Array.isArray(form?.questions) ? form.questions : [];
  const segments = segmentsOf(segmentRules);
  const mine = facts.map(valueOf).filter(fact => fact && fact.formId === formId && fact.respondentId === respondentId);
  const folded = foldAnswerFacts(mine.map(payload => ({ payload })), { formId, respondentId });
  const decided = new Map(assignments.map(valueOf).filter(row => row && row.formId === formId && row.respondentId === respondentId)
    .map(row => [row.submissionId ?? '', row]));

  const sittings = folded
    .map(session => {
      const assignment = decided.get(session.submissionId) ?? null;
      return {
        id: session.submissionId,
        at: session.answeredAt ?? assignment?.decided_at ?? null,
        count: session.count,
        segment: segmentOf(segments, assignment?.segmentId ?? null),
        score: typeof assignment?.score === 'number' ? assignment.score : null,
      };
    })
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const place = new Map(sittings.map((sitting, index) => [sitting.id, index]));

  // One series per question and per thing it was about, in the form's question order; within it, one answer per sitting.
  const latestFact = new Map();
  for (const fact of mine) {
    const key = `${fact.submissionId ?? ''}\u0000${fact.questionId}`;
    const held = latestFact.get(key);
    if (!held || String(fact.answered_at ?? '') > String(held.answered_at ?? '')) latestFact.set(key, fact);
  }
  const order = new Map(questions.map((question, index) => [question.questionId, index]));
  const series = new Map();
  for (const fact of latestFact.values()) {
    if (!order.has(fact.questionId)) continue;
    const question = questions[order.get(fact.questionId)];
    const key = `${fact.questionId}\u0000${aboutKey(fact.about)}`;
    if (!series.has(key)) series.set(key, { id: key, question_id: fact.questionId, about: fact.about ?? null, label: question.label, answers: [] });
    const entry = series.get(key);
    if (text(fact.asked)) entry.label = fact.asked;
    entry.answers.push({ sitting: fact.submissionId ?? '', at: fact.answered_at ?? null, value: fact.value, words: text(fact.words) ?? answerText(question, fact.value) });
  }
  const latest = sittings.at(-1) ?? null;
  const previous = sittings.length > 1 ? sittings.at(-2) : null;
  const lines = [...series.values()]
    .map(entry => {
      const answers = entry.answers.sort((a, b) => (place.get(a.sitting) ?? 0) - (place.get(b.sitting) ?? 0));
      const now = latest ? answers.find(answer => answer.sitting === latest.id) ?? null : null;
      const before = previous ? answers.find(answer => answer.sitting === previous.id) ?? null : null;
      const numeric = answers.length > 0 && answers.every(answer => typeof answer.value === 'number');
      return {
        ...entry,
        answers,
        numeric,
        now,
        before,
        // Changed: answered in both of the last two sittings, in other words. First: answered now and not in the sitting before.
        changed: Boolean(now && before) && now.words !== before.words,
        first: Boolean(previous && now && !before),
      };
    })
    .sort((a, b) => order.get(a.question_id) - order.get(b.question_id) || a.id.localeCompare(b.id));

  const followUp = latest?.segment ? followUps.map(valueOf).find(sequence => sequence?.segmentId === latest.segment.id) ?? null : null;
  return {
    form_id: formId ?? null,
    title: text(form?.title),
    respondent_id: respondentId,
    sittings: sittings.map((sitting, index) => ({ ...sitting, moved: index ? directionOf(sittings[index - 1].segment, sitting.segment) : null,
      changed: index ? lines.filter(line => {
        const now = line.answers.find(answer => answer.sitting === sitting.id);
        const before = line.answers.find(answer => answer.sitting === sittings[index - 1].id);
        return Boolean(now && before) && now.words !== before.words;
      }).length : 0 })),
    latest,
    previous,
    moved: directionOf(previous?.segment, latest?.segment),
    follow_up: (followUp?.steps ?? []).filter(step => step && typeof step.stepId === 'string').map(step => ({ id: step.stepId, label: text(step.label) ?? step.stepId })),
    questions: lines,
    changes: lines.filter(line => line.changed),
  };
}

/**
 * Everyone's latest standing on one form, from its segment assignments: a count per segment (in rank order, segments with
 * nobody included) and one row per person, newest sitting first.
 */
export function latestStandingOf({ formId, assignments = [], segmentRules = [] }) {
  const segments = segmentsOf(segmentRules);
  const byPerson = new Map();
  for (const row of assignments.map(valueOf)) {
    if (!row || row.formId !== formId || typeof row.respondentId !== 'string') continue;
    if (!byPerson.has(row.respondentId)) byPerson.set(row.respondentId, []);
    byPerson.get(row.respondentId).push(row);
  }
  const people = [...byPerson.entries()].map(([respondentId, rows]) => {
    rows.sort((a, b) => String(a.decided_at ?? '').localeCompare(String(b.decided_at ?? '')));
    const last = rows.at(-1);
    const before = rows.length > 1 ? rows.at(-2) : null;
    const now = segmentOf(segments, last.segmentId ?? null);
    const then = before ? segmentOf(segments, before.segmentId ?? null) : null;
    return { respondent_id: respondentId, at: last.decided_at ?? null, segment: now, previous: then, moved: directionOf(then, now), sittings: rows.length };
  }).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  const counts = segments.map(segment => ({ ...segment, count: people.filter(person => person.segment?.id === segment.id).length }));
  const unplaced = people.filter(person => !person.segment || !segments.some(segment => segment.id === person.segment.id)).length;
  return { form_id: formId, counts, unplaced, people };
}
