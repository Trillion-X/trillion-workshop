// packages/ask-questions-sort-answers-follow-up/do-work/save-question-sequence.ts
//
// Persist a draft form (QuestionSequence) as one `question-sequence` published
// record — the SAME record the fill side reads via read-forms-data (L097: one
// write path, builder and importer produce identical records). Pure builder +
// thin I/O wrapper.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  ENGINE_OPERATION_LABEL_TARGET,
  ENGINE_WRITE_BATCH_OPERATION,
  PUBLISHED_RECORD_PATH,
} from './answer-fact-writes';
import type {
  QuestionDescriptor,
  QuestionSequence,
} from '../read-data/question-descriptor';

const PKG = 'ask-questions-sort-answers-follow-up';
export const QUESTION_SEQUENCE_KIND = 'question-sequence';

export interface QuestionSequenceRecord {
  kind: typeof QUESTION_SEQUENCE_KIND;
  formId: string;
  title: string;
  questions: readonly QuestionDescriptor[];
}

export interface QuestionSequenceWrite {
  address_label: string;
  address_mode: 'identity_text';
  path_labels: string[];
  payload: QuestionSequenceRecord;
}

export function questionSequenceAddress(formId: string): string {
  return `package::${PKG}::question-sequence::${formId}`;
}

export function buildSaveQuestionSequenceWrite(seq: QuestionSequence): QuestionSequenceWrite {
  return {
    address_label: questionSequenceAddress(seq.formId),
    address_mode: 'identity_text',
    path_labels: [...PUBLISHED_RECORD_PATH],
    payload: {
      kind: QUESTION_SEQUENCE_KIND,
      formId: seq.formId,
      title: seq.title,
      // `presentation` was DROPPED here while `readQuestionSequences` decodes
      // it, so a form saved with its own mode and button labels read back
      // without them and rendered under the defaults. Nothing failed: the form
      // still worked, one prompt at a time became whatever the surface assumed,
      // and the author's own words for Next and Save were gone. Found when a
      // declared owner action for the same record disagreed with this builder
      // about which fields a sequence has, which is the whole reason two write
      // paths for one record have to be held to the same shape.
      ...(seq.presentation ? { presentation: seq.presentation } : {}),
      questions: seq.questions,
    },
  };
}

export function buildSaveQuestionSequenceRequest(seq: QuestionSequence) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [buildSaveQuestionSequenceWrite(seq)],
    },
  };
}

export async function saveQuestionSequence(seq: QuestionSequence): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildSaveQuestionSequenceRequest(seq));
}
