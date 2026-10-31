// packages/ask-questions-sort-answers-follow-up/read-data/builder-model.ts
//
// Pure immutable operations the builder surface uses to edit a draft form (a
// QuestionSequence). The builder is a DATA editor — it produces the SAME
// question-sequence records the AI or an import would produce (L097: one write
// path). Every operation returns a new sequence; nothing mutates in place.
// Generic — adding a question type needs no change here (the questionTypeId is
// just data the operator picks from the capability registry).

import type {
  QuestionDescriptor,
  QuestionSequence,
} from './question-descriptor.ts';

/** Build a fresh question with a caller-supplied id (caller owns id generation). */
export function newQuestion(
  questionId: string,
  questionTypeId: string,
  label: string,
): QuestionDescriptor {
  return { questionId, questionTypeId, label, required: false };
}

/** Empty draft form. */
export function newQuestionSequence(formId: string, title: string): QuestionSequence {
  return { formId, title, questions: [] };
}

export function addQuestion(
  seq: QuestionSequence,
  question: QuestionDescriptor,
): QuestionSequence {
  return { ...seq, questions: [...seq.questions, question] };
}

export function removeQuestion(seq: QuestionSequence, questionId: string): QuestionSequence {
  return { ...seq, questions: seq.questions.filter((q) => q.questionId !== questionId) };
}

export function updateQuestion(
  seq: QuestionSequence,
  questionId: string,
  patch: Partial<Omit<QuestionDescriptor, 'questionId'>>,
): QuestionSequence {
  return {
    ...seq,
    questions: seq.questions.map((q) => (q.questionId === questionId ? { ...q, ...patch } : q)),
  };
}

/** Move a question to a new index (clamped). Reorder is a pure array splice. */
export function moveQuestion(
  seq: QuestionSequence,
  questionId: string,
  toIndex: number,
): QuestionSequence {
  const from = seq.questions.findIndex((q) => q.questionId === questionId);
  if (from === -1) return seq;
  const next = [...seq.questions];
  const [moved] = next.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, next.length));
  next.splice(clamped, 0, moved);
  return { ...seq, questions: next };
}

export function setTitle(seq: QuestionSequence, title: string): QuestionSequence {
  return { ...seq, title };
}
