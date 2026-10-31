// tools/ask-questions-sort-answers-follow-up/do-work/save-question-sequence.ts
//
// Persist a draft form (QuestionSequence) as one `question-sequence` record, the SAME record the fill side
// reads via read-forms-data (L097: one write path, the builder and an import produce identical records).
// Pure builder; the records-door command sends it.
//
// Changed from the package: the record is a door record { id, type, value } (the package built an engine
// write-batch entry, a write-batch request and a `saveQuestionSequence` sender, all gone with the old engine).

import type { RecordWrite } from '../read-data/record-rows.ts';
import type {
  QuestionDescriptor,
  QuestionSequence,
} from '../read-data/question-descriptor.ts';

export const QUESTION_SEQUENCE_KIND = 'question-sequence';

export interface QuestionSequenceRecord {
  kind: typeof QUESTION_SEQUENCE_KIND;
  formId: string;
  title: string;
  presentation?: QuestionSequence['presentation'];
  questions: readonly QuestionDescriptor[];
}

export function questionSequenceId(formId: string): string {
  return `${QUESTION_SEQUENCE_KIND}:${formId}`;
}

export function buildSaveQuestionSequenceWrite(seq: QuestionSequence): RecordWrite & { value: QuestionSequenceRecord } {
  return {
    id: questionSequenceId(seq.formId),
    type: QUESTION_SEQUENCE_KIND,
    value: {
      kind: QUESTION_SEQUENCE_KIND,
      formId: seq.formId,
      title: seq.title,
      // `presentation` was once dropped here while `readQuestionSequences` decodes it, so a form saved with its
      // own mode and button labels read back without them and rendered under the defaults. Nothing failed: the
      // form still worked, and the author's own words for Next and Save were gone.
      ...(seq.presentation ? { presentation: seq.presentation } : {}),
      questions: seq.questions,
    },
  };
}
