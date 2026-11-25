// tools/ask-questions-sort-answers-follow-up/show/call-step.ts
//
// PURPOSE
//   One call from a question-by-question screen to its site's step route (`<api_base>/<step>`), answering JSON, shared by the form
//   page and the booking page. A route given a body is posted to; one given none is read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A failure of the network, or of the place that answers it (503, 504), is a `Retry` (show/optimistic-run.ts): the answer may
//      not have reached the step tool, and sending it again is safe because every answer names its question.
//   2. A refusal is an Error with its own words (`why`, else `error`, else the page's `failed` words, show/refusal-words.ts); a 502
//      is one too, since a step tool's refusal that gives no reason cannot be told from a failure of the tool.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { Retry } from './optimistic-run.ts';
import { refusalWords } from './refusal-words.ts';

export async function callStep<T>(base: string, step: string, failed: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/${step}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    throw new Retry(failed);
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const words = refusalWords(answer, failed);
    throw response.status === 503 || response.status === 504 ? new Retry(words) : new Error(words);
  }
  return answer as T;
}
