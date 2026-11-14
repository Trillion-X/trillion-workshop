import type {
  ReviewPromptRecord,
  ReviewQueueItemView,
  ReviewResponseRequestRecord,
  ReviewSchedulePolicyRecord,
  ReviewScheduleRecord,
  SpacedRepetitionState,
} from '@/packages/spaced-repetition/read-data/spaced-repetition-types';
import type { ReviewSchedulePolicy } from '@/packages/spaced-repetition/read-data/schedule-next-review';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function latestSchedule(schedules: readonly ReviewScheduleRecord[], promptId: string, learnerId?: string): ReviewScheduleRecord | undefined {
  return [...schedules]
    .filter((schedule) => schedule.promptId === promptId && (!learnerId || schedule.learnerId === learnerId))
    .sort((a, b) => String(b.dueAt ?? b.nextReviewAt ?? '').localeCompare(String(a.dueAt ?? a.nextReviewAt ?? '')))[0];
}

function dueLabel(schedule?: ReviewScheduleRecord): string {
  if (!schedule) return 'Ready when you are';
  if (schedule.state === 'complete' && schedule.nextReviewAt) return `Next review ${schedule.nextReviewAt}`;
  if (schedule.state === 'pending') return 'Saved on this device';
  if (schedule.dueAt) return `Due ${schedule.dueAt}`;
  return 'Due now';
}

export function readSpacedRepetitionState(rows: unknown): SpacedRepetitionState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    prompts: values.filter((value): value is ReviewPromptRecord => kind(value) === 'review-prompt'),
    schedules: values.filter((value): value is ReviewScheduleRecord => kind(value) === 'review-schedule'),
    responses: values.filter((value): value is ReviewResponseRequestRecord => kind(value) === 'review-response-request'),
  };
}

export function readReviewSchedulePolicy(rows: unknown): ReviewSchedulePolicy | null {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  const record = values.find((value): value is ReviewSchedulePolicyRecord => kind(value) === 'review-schedule-policy');
  if (!record) return null;

  const { kind: _kind, policyId: _policyId, ...policy } = record;
  return policy;
}

export function reviewQueueViews(state: SpacedRepetitionState, learnerId?: string): ReviewQueueItemView[] {
  return state.prompts
    .map((prompt) => {
      const schedule = latestSchedule(state.schedules, prompt.promptId, learnerId);
      return {
        prompt,
        schedule,
        dueLabel: dueLabel(schedule),
        isDue: !schedule || schedule.state !== 'complete',
      };
    })
    .filter((view) => view.isDue)
    .sort((a, b) => String(a.schedule?.dueAt ?? '').localeCompare(String(b.schedule?.dueAt ?? '')) || a.prompt.prompt.localeCompare(b.prompt.prompt));
}
