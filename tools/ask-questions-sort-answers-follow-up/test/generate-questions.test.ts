// tools/ask-questions-sort-answers-follow-up/test/generate-questions.test.ts
//
// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/__tests__/generate-questions.test.ts.
// Proves the content -> recall-questions transform: pure + deterministic cloze generation, and a real node
// subprocess run the way the tool row runs it. The output records match the consumer's QuestionDescriptor
// shape (questionTypeId resolves against the open registry, `text`), so the generated questions drop straight
// into the fill loop. Changed from the package: the sample text is synthetic, and the subprocess case takes
// the tool's one JSON argument and answers { questions } (the package's file arguments were the old runner's).

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { execFileSync } from 'node:child_process';
import {
  generateQuestions,
  splitSentences,
  keyWord,
  questionFromSentence,
} from '../do-work/generate-questions.mjs';

const CONTENT =
  'The detector marks the ball in every frame. The pause happens just before the other side strikes. Consistent footwork wins long rallies. Go.';

describe('generate-questions — pure deterministic cloze generation', () => {
  it('splits into meaningful sentences (drops the short fragment)', () => {
    const s = splitSentences(CONTENT);
    expect(s.length).toBe(3); // "Go." is too short
    expect(s[0]).toMatch(/detector/);
  });

  it('picks the longest non-stopword token as the blank', () => {
    expect(keyWord('Consistent footwork wins long rallies.')).toBe('Consistent');
  });

  it('blanks the most significant word as a cloze + records the answer', () => {
    const q = questionFromSentence('Consistent footwork wins long rallies.', 0, 'obs:1');
    expect(q.kind).toBe('question');
    expect(q.questionTypeId).toBe('text');
    expect(q.answer).toBe('Consistent'); // the longest non-stopword token
    expect(q.label).toBe('_____ footwork wins long rallies.');
    expect(q.required).toBe(true);
    expect(q.sourceRef).toBe('obs:1');
  });

  it('falls back to a free-recall prompt when no significant word exists', () => {
    const q = questionFromSentence('Go now and do it ok.', 2, '');
    expect(q.label).toMatch(/^Recall: /);
    expect(q.answer).toBe('');
  });

  it('is deterministic — same content yields identical question ids', () => {
    const a = generateQuestions(CONTENT, { sourceRef: 'x' });
    const b = generateQuestions(CONTENT, { sourceRef: 'x' });
    expect(a.map((q) => q.questionId)).toEqual(b.map((q) => q.questionId));
    expect(a.length).toBe(3);
    // every record carries an `id` (a record is addressed by record.id)
    expect(a.every((q) => q.id === q.questionId)).toBe(true);
  });

  it('honours max', () => {
    expect(generateQuestions(CONTENT, { max: 2 }).length).toBe(2);
  });
});

describe('generate-questions command — runs as the tool row runs it (node subprocess)', () => {
  const script = new URL('../do-work/generate-questions.mjs', import.meta.url).pathname;

  it('reads one JSON input and answers { questions } of question records', () => {
    const out = JSON.parse(execFileSync('node', [script, JSON.stringify({ text: CONTENT, max: 5, source_ref: 'obs:42' })], { stdio: 'pipe' }).toString().trim().split('\n').at(-1));
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions.length).toBe(3);
    expect(out.questions[0].kind).toBe('question');
    expect(out.questions[0].questionTypeId).toBe('text');
    expect(out.questions.every((r: any) => r.sourceRef === 'obs:42')).toBe(true);
  });
});
