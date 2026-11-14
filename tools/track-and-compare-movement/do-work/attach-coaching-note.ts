import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { MotionCoachingAttachmentRecord } from '../read-data/motion-comparison-factor-types.ts';

export const ATTACH_MOTION_COACHING_NOTE_ACTION = 'action:motion-comparison.attach-coaching-note';

export type AttachCoachingNoteDraft = {
  attachmentId?: string;
  comparisonId: string;
  playerId?: string;
  practiceTargetId?: string;
  note: string;
  createdBy?: string;
  now?: Date;
};

export type AttachCoachingNoteInput = {
  attachment_id: string;
  attachment_record: MotionCoachingAttachmentRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildAttachCoachingNoteInput(draft: AttachCoachingNoteDraft): AttachCoachingNoteInput {
  const note = draft.note.trim();
  if (!note) throw new Error('Write a coaching note first');
  const attachmentId = draft.attachmentId ?? generatedId('motion-coaching-attachment');
  return {
    attachment_id: attachmentId,
    attachment_record: {
      kind: 'motion-coaching-attachment',
      attachmentId,
      comparisonId: draft.comparisonId,
      playerId: draft.playerId,
      practiceTargetId: draft.practiceTargetId,
      note,
      createdBy: draft.createdBy,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function attachCoachingNote(input: AttachCoachingNoteInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ATTACH_MOTION_COACHING_NOTE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
