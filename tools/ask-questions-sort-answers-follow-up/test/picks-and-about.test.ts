// Picks answers (one or several, with an other option that needs the person's own words), link answers, and questions
// asked about an earlier answer (the label filled in and the thing kept with each answer fact).
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { coercePicks, validateAnswer } from '../read-data/validate-answer.ts';
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import { answerText, resolveAbout, type QuestionDescriptor } from '../read-data/question-descriptor.ts';
import { readDescriptor } from '../read-data/read-forms-data.ts';
import { buildAnswerFactWrites } from '../do-work/answer-fact-writes.ts';
import { registry } from '../do-work/check-answers.mjs';

const options = [{ label: 'Forehand', value: 'forehand' }, { label: 'Serve', value: 'serve' }];
const other = { label: 'Other', value: 'other' };

describe('coercePicks', () => {
  it('reads { picked, other }, a list or one value, and drops repeats and blanks', () => {
    expect(coercePicks({ picked: ['serve', 'serve', ' '], other: '  ' })).toEqual({ ok: true, value: { picked: ['serve'] } });
    expect(coercePicks(['forehand', 'serve'])).toEqual({ ok: true, value: { picked: ['forehand', 'serve'] } });
    expect(coercePicks('serve')).toEqual({ ok: true, value: { picked: ['serve'] } });
    expect(coercePicks({ picked: [] })).toEqual({ ok: true, value: undefined });
    expect(coercePicks({ picked: [3] })).toEqual({ ok: false });
    expect(coercePicks({ picked: ['other'], other: 'my lob' })).toEqual({ ok: true, value: { picked: ['other'], other: 'my lob' } });
  });
});

describe('validateAnswer for picks', () => {
  const one = { options, other };
  const many = { options, other, multiple: true };
  it('takes only listed picks, one unless several are allowed', () => {
    expect(validateAnswer({ picked: ['serve'] }, 'picks', {}, one).ok).toBe(true);
    expect(validateAnswer({ picked: ['lob'] }, 'picks', {}, one)).toEqual({ ok: false, message: 'Pick from the answers shown' });
    expect(validateAnswer({ picked: ['serve', 'forehand'] }, 'picks', {}, one)).toEqual({ ok: false, message: 'Pick one answer' });
    expect(validateAnswer({ picked: ['serve', 'forehand'] }, 'picks', {}, many).ok).toBe(true);
  });
  it('asks for the other option\'s words, and counts picks against min and max', () => {
    expect(validateAnswer({ picked: ['other'] }, 'picks', {}, one)).toEqual({ ok: false, message: 'Say what Other is' });
    expect(validateAnswer({ picked: ['other'], other: 'lob' }, 'picks', {}, one).ok).toBe(true);
    expect(validateAnswer({ picked: ['serve'] }, 'picks', { min: 2 }, many).ok).toBe(false);
    expect(validateAnswer({ picked: [] }, 'picks', { required: true }, many)).toEqual({ ok: false, message: 'This question is required' });
    expect(validateAnswer(undefined, 'picks', { required: false }, many)).toEqual({ ok: true });
  });
  it('is checked through the fill model with the question\'s own options', () => {
    const question: QuestionDescriptor = { questionId: 'stroke', questionTypeId: 'picks', label: 'Stroke', required: true, options, other };
    expect(buildFillScreenModel([question], registry, { stroke: { picked: ['lob'] } }).allValid).toBe(false);
    expect(buildFillScreenModel([question], registry, { stroke: { picked: ['serve'] } }).allValid).toBe(true);
  });
});

describe('link answers', () => {
  it('take a full web link and refuse anything else', () => {
    const question: QuestionDescriptor = { questionId: 'video', questionTypeId: 'link', label: 'Video' };
    expect(buildFillScreenModel([question], registry, { video: 'https://youtu.be/abc' }).allValid).toBe(true);
    expect(buildFillScreenModel([question], registry, { video: 'youtu.be/abc' }).allValid).toBe(false);
    expect(buildFillScreenModel([question], registry, {}).allValid).toBe(true);
  });
});

describe('questions about an earlier answer', () => {
  const stroke: QuestionDescriptor = { questionId: 'stroke', questionTypeId: 'picks', label: 'Stroke', options, other };
  const feeling: QuestionDescriptor = { questionId: 'feeling', questionTypeId: 'long-text', label: 'When does your {stroke} break down?', about: { name: 'stroke', fromQuestionId: 'stroke' } };
  it('fill the label from the picked label and say what the answer is about', () => {
    expect(resolveAbout(feeling, [stroke, feeling], { stroke: { picked: ['serve'] } })).toEqual({ label: 'When does your serve break down?', about: { stroke: 'Serve' } });
    expect(resolveAbout(feeling, [stroke, feeling], { stroke: { picked: ['other'], other: 'Lob' } })).toEqual({ label: 'When does your lob break down?', about: { stroke: 'Lob' } });
    expect(resolveAbout(feeling, [stroke, feeling], {})).toEqual({ label: 'When does your {stroke} break down?', about: null });
  });
  it('keep the thing with each answer fact, so the same question about another stroke is another series', () => {
    const [fact] = buildAnswerFactWrites('form', 'person', { feeling: 'late' }, '2026-11-24T00:00:00.000Z', 's1', { feeling: { stroke: 'Serve' } });
    expect(fact.value.about).toEqual({ stroke: 'Serve' });
    const [plain] = buildAnswerFactWrites('form', 'person', { feeling: 'late' }, '2026-11-24T00:00:00.000Z');
    expect('about' in plain.value).toBe(false);
  });
  it('are read back from rows with their picks shape and about', () => {
    expect(readDescriptor({ questionId: 'f', questionTypeId: 'picks', label: 'F', multiple: true, other, help: 'Pick any', about: { name: 'stroke', from_question_id: 'stroke' } }))
      .toMatchObject({ multiple: true, other, help: 'Pick any', about: { name: 'stroke', fromQuestionId: 'stroke' } });
  });
});

describe('answerText', () => {
  it('writes picks by their labels, the other option with its words', () => {
    const question: QuestionDescriptor = { questionId: 'q', questionTypeId: 'picks', label: 'Q', options, other, multiple: true };
    expect(answerText(question, { picked: ['serve', 'other'], other: 'my lob' })).toBe('Serve; Other: my lob');
    expect(answerText(question, 'words')).toBe('words');
    expect(answerText(question, 7)).toBe('7');
  });
});
