// packages/request-intake/do-work/record-submission.ts
//
// Form Builder v2 T3 — the submission fold. request-form's submit fires the
// surface's owner_action; this pure builder turns that opaque payload into
// ONE self-describing EEAF record write ({ kind: "form-submission",
// surface_id, values, submitted_at }) at a deterministic per-submission
// address. Values ride VERBATIM — no field-kind inspection anywhere (enum
// dissolution / L090). Trigger-rules match on kind + surface_id; projection
// views read the same rows. Zero imports from request-form.

export type AnyRecord = Record<string, unknown>;

export interface RecordSubmissionInput {
  surfaceId: string;
  values: AnyRecord;
  /** Injected ISO 8601 clock — deterministic in tests. */
  submittedAt: string;
  /** Injected unique id — no ambient randomness. */
  submissionId: string;
  /** Optional opaque submitter context, copied verbatim. */
  context?: AnyRecord;
}

export interface RecordSubmissionWrite {
  address: string;
  path: string[];
  payload: AnyRecord;
}

export function buildFormSubmissionWrite(input: RecordSubmissionInput): RecordSubmissionWrite {
  return {
    address: `request-intake.form::${input.surfaceId}::submission::${input.submissionId}`,
    path: ['current-item', 'published-record'],
    payload: {
      kind: 'form-submission',
      surface_id: input.surfaceId,
      submission_id: input.submissionId,
      values: { ...input.values },
      submitted_at: input.submittedAt,
      ...(input.context ? { context: input.context } : {}),
    },
  };
}

const equalsCondition = (path: string, value: unknown): AnyRecord => ({
  $kind: 'binding',
  select: { from: 'change', path },
  transform: [{ op: 'op:core.equals', args: { value } }],
});

/**
 * The ONE trigger-rule DATA row that automates a form. Shape matches the
 * trigger engine's serde exactly (TriggerRule in
 * trigger-engine/source/src/slot_work/rule_record.rs): 3-segment path with
 * literal `trigger-rule` middle segment; topic=data_state +
 * trigger_type=delta; match_condition.conditions = binding predicates;
 * dispatch = { target, output_template } (same grammar as the proven CRM
 * activity rule). Each submission field binds explicitly
 * (same select grammar as the proven CRM activity rule).
 */
export function buildSubmissionTriggerRule(input: {
  surfaceId: string;
  definitionId: string;
  ruleId?: string;
}): { path: string[]; payload: AnyRecord } {
  const ruleId = input.ruleId ?? `trigger:request-intake:on-form-submission-${input.surfaceId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  return {
    path: ['request-intake', 'trigger-rule', ruleId],
    payload: {
      kind: 'trigger-rule',
      id: ruleId,
      is_active: true,
      topic: 'data_state',
      trigger_type: 'delta',
      match_condition: {
        conditions: [
          equalsCondition('kind', 'form-submission'),
          equalsCondition('surface_id', input.surfaceId),
        ],
      },
      dispatch: {
        target: 'slot::workflow',
        output_template: {
          operation: 'execute_definition',
          definition_id: input.definitionId,
          include_output: false,
          include_steps: false,
          input: {
            surface_id: { $kind: 'binding', select: { from: 'change', path: 'surface_id' } },
            submission_id: { $kind: 'binding', select: { from: 'change', path: 'submission_id' } },
            values: { $kind: 'binding', select: { from: 'change', path: 'values' } },
            submitted_at: { $kind: 'binding', select: { from: 'change', path: 'submitted_at' } },
          },
        },
      },
    },
  };
}
