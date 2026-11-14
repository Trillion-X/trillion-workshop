// packages/ask-questions-sort-answers-follow-up/show/inputs/index.ts
//
// The owner-provided capability map: inputComponentKey -> leaf component. This
// is the ONE place that binds a question-type-capability's `inputComponentKey`
// (DATA, from things-to-store-and-run.json) to its render leaf. The fill-surface
// handler dispatches `resolveInputComponent(key)` — it NEVER switches on a
// questionTypeId (enum-dissolution / L090). Adding a question type = ship one
// leaf here + one registry row + one map entry; zero handler/dispatcher change.

import type { QuestionInputComponent } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';
import { TextInput } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/TextInput';
import { MultilineTextInput } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/MultilineTextInput';
import { ChoiceInput } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/ChoiceInput';
import { RatingInput } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/RatingInput';
import { NumberInput } from './NumberInput';
import { EvidenceReferenceInput } from './EvidenceReferenceInput';

/** Stable fallback when a question references an unknown inputComponentKey:
 *  render it as free text rather than dropping the question (graceful). */
export const FALLBACK_INPUT_COMPONENT_KEY = 'text';

export const QUESTION_INPUT_COMPONENTS: Readonly<Record<string, QuestionInputComponent>> = {
  text: TextInput,
  'long-text': MultilineTextInput,
  choice: ChoiceInput,
  rating: RatingInput,
  number: NumberInput,
  'evidence-reference': EvidenceReferenceInput,
};

/** Resolve a leaf for an inputComponentKey, falling back to text. */
export function resolveInputComponent(key: string | null | undefined): QuestionInputComponent {
  return (
    (key != null && QUESTION_INPUT_COMPONENTS[key]) ||
    QUESTION_INPUT_COMPONENTS[FALLBACK_INPUT_COMPONENT_KEY]
  );
}

export { TextInput, MultilineTextInput, ChoiceInput, RatingInput, NumberInput, EvidenceReferenceInput };
