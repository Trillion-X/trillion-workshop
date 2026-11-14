// packages/group/read-data/board-questions.test.ts
import { describe, it, expect } from 'vitest';
import { isQuestionLine, cardQuestions, isQuestionCard, boardQuestions, cardsWithQuestions, boardHasQuestions, questionsText } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-questions.ts';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);

describe('isQuestionLine', () => {
  it('a line ending with ? is a question', () => {
    expect(isQuestionLine('What is our pricing?')).toBe(true);
    expect(isQuestionLine('  ready to ship?  ')).toBe(true);
  });
  it('an un-punctuated line starting with a WH-word is a question', () => {
    expect(isQuestionLine('How do we onboard users')).toBe(true);
    expect(isQuestionLine('Why are we waiting')).toBe(true);
  });
  it('a bare auxiliary inversion WITHOUT ? is NOT flagged (imperative collision guard)', () => {
    expect(isQuestionLine('Do the work')).toBe(false); // imperative, not "do we…?"
    expect(isQuestionLine('Will Smith joins')).toBe(false); // a name
    expect(isQuestionLine('Are we ready to launch?')).toBe(true); // the ? makes it unambiguous
  });
  it('a plain statement is not a question', () => {
    expect(isQuestionLine('Ship the product next week')).toBe(false);
    expect(isQuestionLine('')).toBe(false);
    expect(isQuestionLine('   ')).toBe(false);
  });
  it('a custom starter set overrides the default (DATA, not a hardcoded branch)', () => {
    // With an empty starter set, only the '?' rule fires.
    expect(isQuestionLine('How do we onboard', new Set())).toBe(false);
    expect(isQuestionLine('How do we onboard?', new Set())).toBe(true);
  });
});

describe('cardQuestions / isQuestionCard', () => {
  it('pulls the question lines from a card, de-duped, in order', () => {
    const c = card('a', 'Roadmap\nWhat is our pricing?\nShip v2\nHow do we onboard?\nwhat is our pricing?');
    expect(cardQuestions(c)).toEqual(['What is our pricing?', 'How do we onboard?']); // dupe (case-insensitive) dropped
    expect(isQuestionCard(c)).toBe(true);
  });
  it('a card with no question lines yields none', () => {
    expect(cardQuestions(card('a', 'Just a plan\nDo the work'))).toEqual([]); // "Do the work" is imperative, not a question
  });
});

describe('board-level', () => {
  const items = [
    card('a', 'Pricing\nWhat should we charge?'),
    card('b', 'Onboarding\nHow do we onboard?\nWhen do we launch?'),
    card('c', 'Just build it'),
  ];
  it('boardQuestions lists each card with its questions', () => {
    expect(boardQuestions(items)).toEqual([
      { cardId: 'a', questions: ['What should we charge?'] },
      { cardId: 'b', questions: ['How do we onboard?', 'When do we launch?'] },
    ]);
  });
  it('cardsWithQuestions is the sorted set + the gate', () => {
    expect(cardsWithQuestions(items)).toEqual(['a', 'b']);
    expect(boardHasQuestions(items)).toBe(true);
    expect(boardHasQuestions([card('x', 'no questions here')])).toBe(false);
  });
  it('questionsText renders a flat, total-de-duped report', () => {
    const text = questionsText(items, 'Board');
    expect(text).toContain('# Board');
    expect(text).toContain('## Open questions (3)');
    expect(text).toContain('- What should we charge?');
    expect(text).toContain('- When do we launch?');
  });
  it('questionsText is the honest empty line when none', () => {
    expect(questionsText([card('x', 'nothing')])).toBe('No open questions');
  });
});
