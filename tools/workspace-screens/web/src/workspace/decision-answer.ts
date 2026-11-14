// src/workspace/decision-answer.ts
//
// PURPOSE
//   A decision's summary row and the hover form that answers "How did it go?" from a list: the one form Decisions and
//   Home both offer, kept apart from the Decisions screen so Home answers a decision without loading that screen.

import { postJson } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';
import type { HoverForm } from '../../parts/ui/show/record-views/hover-form';

export type Summary = { case_id: string; goal: string; status: string; decision: string | null; created_at: string; outcome_question: string | null; recheck_on: string | null; pursuits?: { id: string; title: string }[]; move?: string | null; next_action?: string | null; success_measure?: string | null; stance?: string | null; progress?: string };

// "How did it go?" answered from the list: hovering "Your answer needed" shows what was decided and how you said you
// would know, with the box to say what happened. The same route the decision's own tab answers through.
export const answerForm = (reload: () => void) => (row: Summary): HoverForm | null => row.outcome_question ? {
  title: row.outcome_question,
  details: [
    { label: 'What was decided', text: row.move ?? row.decision },
    { label: 'The next step was', text: row.next_action },
    { label: 'How you said you would know', text: row.success_measure },
  ],
  fields: [{ name: 'text', label: 'What happened, in your words', placeholder: 'What you saw, what changed, or what did not' }],
  submit: 'Save my answer',
  run: async values => {
    const answer = await postJson<{ said?: string }>('/work/api/decisions/answer', { case_id: row.case_id, values });
    if (answer.said) notify(answer.said, { kind: 'done' });
    reload();
  },
} : null;
