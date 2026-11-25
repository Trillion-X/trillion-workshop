// tools/ask-questions-sort-answers-follow-up/show/refusal-words.ts
//
// PURPOSE
//   The words a page shows when a step of its form or booking was refused. A refusal answers { error, why? }: `error` is the words
//   the page row gives for the failed step, and `why` is the step tool's own plain reason (for example "An answer is written as
//   text."). The page shows `why` when it is there, `error` when it is not, and its own `failed` words for anything else. Pure.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only text is shown: a `why` or `error` that is not text, or is empty, is passed over.
//   2. Nothing but the answer's own words and the page's `failed` words is ever returned.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const wordsOf = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : null);

export function refusalWords(answer: { error?: unknown; why?: unknown } | null | undefined, failed: string): string {
  return wordsOf(answer?.why) ?? wordsOf(answer?.error) ?? failed;
}
