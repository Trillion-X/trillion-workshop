import { buildAnswerFactWrites, type WriteEntry as AnswerFactWrite } from '../../ask-questions-sort-answers-follow-up/do-work/answer-fact-writes';
import {
  readSessionCatalog,
  type SessionCatalogEntry,
} from '../../coordination-session/read-data/read-session-catalog';
import { publishForm, type AnyRecord, type PublishFormResult, type PublishNode } from './publish-form';

export const STRUCTURED_SELECTION_KIND = 'session-selection-submission';
export const SESSION_CATALOG_OWNER_REF = 'package::coordination-session::read-session-catalog';
export const ANSWER_FACT_OWNER_REF = 'package::ask-questions-sort-answers-follow-up::answer-fact-writes';

export type SelectionOperation =
  | 'open'
  | 'save_draft'
  | 'recover_draft'
  | 'validate'
  | 'submit'
  | 'revise'
  | 'cancel'
  | 'resolve_duplicate';

export type SubmissionState = 'open' | 'draft' | 'valid' | 'submitted' | 'revision' | 'cancelled';

export interface DuplicateResolutionProvenance {
  status: 'not_required' | 'pending' | 'resolved';
  duplicate_subject_refs?: string[];
  canonical_subject_ref?: string;
  resolution_ref?: string;
  resolved_at?: string;
}

export interface SubjectIdentity {
  identity_ref: string;
  contact_ref?: string;
  duplicate_resolution: DuplicateResolutionProvenance;
}

export interface RankedPreference {
  rank: number;
  interval: AnyRecord;
  place: AnyRecord;
  mode: AnyRecord;
  preference_dimension: string;
  session_ref: string;
}

export interface ContactPreferences {
  channels?: string[];
  quiet_hours?: AnyRecord;
  locale?: string;
  consent_records?: AnyRecord[];
  [key: string]: unknown;
}

export interface SubmissionProvenance {
  surface_ref: string;
  actor_ref: string;
  recorded_at: string;
  submitted_bytes_ref?: string;
  change_ref: string;
  [key: string]: unknown;
}

export interface StructuredSelectionSubmission {
  kind: typeof STRUCTURED_SELECTION_KIND;
  submission_id: string;
  subject_identity: SubjectIdentity;
  catalog_entry_id: string;
  selected_session_refs: string[];
  ranked_preferences: RankedPreference[];
  intake_answer_fact_refs: string[];
  contact_preferences: ContactPreferences;
  submission_state: SubmissionState;
  recovery_token_ref?: string;
  provenance: SubmissionProvenance;
}

export interface FieldRecovery {
  field: string;
  code: string;
  message: string;
  recovery: AnyRecord;
}

export class StructuredSelectionValidationError extends Error {
  readonly fieldRecoveries: FieldRecovery[];

  constructor(fieldRecoveries: FieldRecovery[]) {
    super(fieldRecoveries.map((failure) => `${failure.field}: ${failure.message}`).join('; '));
    this.name = 'StructuredSelectionValidationError';
    this.fieldRecoveries = fieldRecoveries;
  }
}

export interface StructuredSelectionOwners {
  // These are caller-supplied snapshots and owner identifiers, not authority
  // proofs. The invoking owner must authenticate, read current state and apply
  // returned write intents atomically. This module performs no durable effect.
  catalog: {
    owner_ref: typeof SESSION_CATALOG_OWNER_REF;
    entries: readonly SessionCatalogEntry[];
  };
  answer_facts: {
    owner_ref: typeof ANSWER_FACT_OWNER_REF;
  };
}

export interface StructuredSelectionOperationInput {
  operation: SelectionOperation;
  submission?: StructuredSelectionSubmission;
  patch?: Partial<Omit<StructuredSelectionSubmission, 'kind' | 'submission_id' | 'submission_state'>>;
  open?: Omit<StructuredSelectionSubmission, 'kind' | 'selected_session_refs' | 'ranked_preferences' | 'intake_answer_fact_refs' | 'contact_preferences' | 'submission_state'> & {
    selected_session_refs?: string[];
    ranked_preferences?: RankedPreference[];
    intake_answer_fact_refs?: string[];
    contact_preferences?: ContactPreferences;
  };
  recovery_token_ref?: string;
  intake_answers?: Readonly<Record<string, unknown>>;
  duplicate_resolution?: DuplicateResolutionProvenance;
  owners: StructuredSelectionOwners;
}

export interface StructuredSelectionOperationResult {
  record: StructuredSelectionSubmission;
  answerFactWrites: AnswerFactWrite[];
  fieldRecoveries: FieldRecovery[];
  capacityClaimRequested: boolean;
}

function requireText(value: string, field: string, failures: FieldRecovery[]): void {
  if (value.trim()) return;
  failures.push({
    field,
    code: 'required',
    message: 'must be a non-empty string',
    recovery: { action: 'provide_value' },
  });
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeRankedPreferences(preferences: readonly RankedPreference[]): RankedPreference[] {
  const grouped = new Map<string, Array<{ preference: RankedPreference; sourceIndex: number }>>();
  preferences.forEach((preference, sourceIndex) => {
    if (!Number.isSafeInteger(preference.rank) || preference.rank < 1) {
      throw new StructuredSelectionValidationError([{
        field: `ranked_preferences[${sourceIndex}].rank`,
        code: 'invalid_rank',
        message: 'Rank must be a positive integer.',
        recovery: { action: 'provide_valid_rank' },
      }]);
    }
    const dimension = preference.preference_dimension.trim();
    const group = grouped.get(dimension) ?? [];
    group.push({ preference: { ...preference, preference_dimension: dimension }, sourceIndex });
    grouped.set(dimension, group);
  });

  const normalized: RankedPreference[] = [];
  for (const group of grouped.values()) {
    group
      .sort((left, right) => left.preference.rank - right.preference.rank || left.sourceIndex - right.sourceIndex)
      .forEach(({ preference }, index) => normalized.push({ ...preference, rank: index + 1 }));
  }
  return normalized;
}

function normalizedRecord(record: StructuredSelectionSubmission): StructuredSelectionSubmission {
  return {
    ...record,
    selected_session_refs: uniqueText(record.selected_session_refs),
    ranked_preferences: normalizeRankedPreferences(record.ranked_preferences),
    intake_answer_fact_refs: uniqueText(record.intake_answer_fact_refs),
    contact_preferences: { ...record.contact_preferences },
    subject_identity: {
      ...record.subject_identity,
      duplicate_resolution: { ...record.subject_identity.duplicate_resolution },
    },
    provenance: { ...record.provenance },
  };
}

function validateCurrentCatalog(record: StructuredSelectionSubmission, owners: StructuredSelectionOwners): FieldRecovery[] {
  if (owners.catalog.owner_ref !== SESSION_CATALOG_OWNER_REF) {
    throw new Error(`catalog resolution must use ${SESSION_CATALOG_OWNER_REF}`);
  }

  const currentEntries = readSessionCatalog(owners.catalog.entries, {
    catalog_entry_refs: [record.catalog_entry_id],
  });
  if (currentEntries.length !== 1 || currentEntries[0].catalog_entry_id !== record.catalog_entry_id) {
    const staleEntry = owners.catalog.entries.find((entry) => entry.catalog_entry_id === record.catalog_entry_id);
    return [{
      field: 'catalog_entry_id',
      code: staleEntry?.superseded_by ? 'superseded_catalog_entry' : 'catalog_entry_unavailable',
      message: staleEntry?.superseded_by
        ? 'catalog entry has been superseded'
        : 'catalog entry is not current or available',
      recovery: staleEntry?.superseded_by
        ? { action: 'select_successor', successor_catalog_entry_id: staleEntry.superseded_by }
        : { action: 'reopen_catalog' },
    }];
  }

  const currentEntry = currentEntries[0];
  const availableSessions = new Set(currentEntry.session_refs);
  const failures: FieldRecovery[] = [];
  record.selected_session_refs.forEach((sessionRef, index) => {
    if (availableSessions.has(sessionRef)) return;
    failures.push({
      field: `selected_session_refs[${index}]`,
      code: 'session_not_in_current_catalog',
      message: 'selected session does not resolve through the current catalog entry',
      recovery: { action: 'remove_or_replace_session', catalog_entry_id: currentEntry.catalog_entry_id },
    });
  });
  record.ranked_preferences.forEach((preference, index) => {
    if (availableSessions.has(preference.session_ref)) return;
    failures.push({
      field: `ranked_preferences[${index}].session_ref`,
      code: 'preference_session_not_in_current_catalog',
      message: 'ranked preference does not resolve through the current catalog entry',
      recovery: { action: 'remove_or_replace_preference', catalog_entry_id: currentEntry.catalog_entry_id },
    });
  });
  return failures;
}

export function validateStructuredSelectionSubmission(
  submission: StructuredSelectionSubmission,
  owners: StructuredSelectionOwners,
): StructuredSelectionSubmission {
  const record = normalizedRecord(submission);
  const failures: FieldRecovery[] = [];
  requireText(record.submission_id, 'submission_id', failures);
  requireText(record.subject_identity.identity_ref, 'subject_identity.identity_ref', failures);
  requireText(record.catalog_entry_id, 'catalog_entry_id', failures);
  requireText(record.provenance.surface_ref, 'provenance.surface_ref', failures);
  requireText(record.provenance.actor_ref, 'provenance.actor_ref', failures);
  requireText(record.provenance.recorded_at, 'provenance.recorded_at', failures);
  requireText(record.provenance.change_ref, 'provenance.change_ref', failures);

  if (record.selected_session_refs.length === 0) {
    failures.push({
      field: 'selected_session_refs',
      code: 'selection_required',
      message: 'at least one session must be selected',
      recovery: { action: 'select_one_or_more' },
    });
  }

  record.ranked_preferences.forEach((preference, index) => {
    requireText(preference.preference_dimension, `ranked_preferences[${index}].preference_dimension`, failures);
    requireText(preference.session_ref, `ranked_preferences[${index}].session_ref`, failures);
  });
  failures.push(...validateCurrentCatalog(record, owners));

  if (failures.length > 0) throw new StructuredSelectionValidationError(failures);
  return record;
}

function requireSubmission(input: StructuredSelectionOperationInput): StructuredSelectionSubmission {
  if (!input.submission) throw new Error(`${input.operation} requires submission`);
  return input.submission;
}

function mergePatch(
  record: StructuredSelectionSubmission,
  patch: StructuredSelectionOperationInput['patch'],
): StructuredSelectionSubmission {
  if (!patch) return normalizedRecord(record);
  for (const field of ['kind', 'submission_id', 'submission_state']) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) throw new Error(`patch cannot change ${field}`);
  }
  return normalizedRecord({
    ...record,
    ...patch,
    subject_identity: patch.subject_identity ?? record.subject_identity,
    provenance: patch.provenance ?? record.provenance,
    contact_preferences: patch.contact_preferences ?? record.contact_preferences,
  });
}

function buildAnswerWrites(
  record: StructuredSelectionSubmission,
  answers: Readonly<Record<string, unknown>> | undefined,
  owners: StructuredSelectionOwners,
): AnswerFactWrite[] {
  if (!answers || Object.keys(answers).length === 0) return [];
  if (owners.answer_facts.owner_ref !== ANSWER_FACT_OWNER_REF) {
    throw new Error(`answer persistence must use ${ANSWER_FACT_OWNER_REF}`);
  }
  return buildAnswerFactWrites(
    `structured-session-selection:${record.catalog_entry_id}`,
    record.subject_identity.identity_ref,
    answers,
    record.provenance.recorded_at,
    record.submission_id,
  );
}

function result(
  record: StructuredSelectionSubmission,
  answerFactWrites: AnswerFactWrite[] = [],
  capacityClaimRequested = false,
): StructuredSelectionOperationResult {
  return { record, answerFactWrites, fieldRecoveries: [], capacityClaimRequested };
}

export function applyStructuredSelectionOperation(
  input: StructuredSelectionOperationInput,
): StructuredSelectionOperationResult {
  const transitions: Record<Exclude<SelectionOperation, 'open'>, readonly SubmissionState[]> = {
    save_draft: ['open', 'draft', 'valid', 'revision'],
    recover_draft: ['draft', 'revision'],
    validate: ['open', 'draft', 'valid', 'revision'],
    submit: ['open', 'draft', 'valid', 'revision'],
    revise: ['draft', 'valid', 'submitted', 'cancelled'],
    cancel: ['open', 'draft', 'valid', 'submitted', 'revision', 'cancelled'],
    resolve_duplicate: ['open', 'draft', 'valid', 'revision'],
  };
  if (input.operation !== 'open') {
    if (!Object.prototype.hasOwnProperty.call(transitions, input.operation)) throw new Error('Unknown selection operation');
    const record = requireSubmission(input);
    if (!transitions[input.operation].includes(record.submission_state)) {
      throw new Error(`Cannot ${input.operation} a ${record.submission_state} submission`);
    }
  }
  if (input.operation === 'open') {
    if (!input.open) throw new Error('open requires open input');
    return result(normalizedRecord({
      kind: STRUCTURED_SELECTION_KIND,
      submission_id: input.open.submission_id,
      subject_identity: input.open.subject_identity,
      catalog_entry_id: input.open.catalog_entry_id,
      selected_session_refs: input.open.selected_session_refs ?? [],
      ranked_preferences: input.open.ranked_preferences ?? [],
      intake_answer_fact_refs: input.open.intake_answer_fact_refs ?? [],
      contact_preferences: input.open.contact_preferences ?? {},
      submission_state: 'open',
      recovery_token_ref: input.open.recovery_token_ref,
      provenance: input.open.provenance,
    }));
  }

  if (input.operation === 'recover_draft') {
    // This checks consistency of the supplied draft handle; it does not read a
    // private store or authenticate a person. Recovery access belongs to the caller.
    const record = requireSubmission(input);
    if (!record.recovery_token_ref || record.recovery_token_ref !== input.recovery_token_ref) {
      throw new StructuredSelectionValidationError([{
        field: 'recovery_token_ref',
        code: 'recovery_token_mismatch',
        message: 'recovery token does not match the saved draft',
        recovery: { action: 'request_valid_recovery_token' },
      }]);
    }
    return result(normalizedRecord(record));
  }

  if (input.operation === 'resolve_duplicate') {
    const record = requireSubmission(input);
    if (!input.duplicate_resolution || input.duplicate_resolution.status !== 'resolved') {
      throw new Error('resolve_duplicate requires resolved duplicate provenance');
    }
    return result(normalizedRecord({
      ...record,
      subject_identity: {
        ...record.subject_identity,
        identity_ref: input.duplicate_resolution.canonical_subject_ref ?? record.subject_identity.identity_ref,
        duplicate_resolution: { ...input.duplicate_resolution },
      },
    }));
  }

  if (input.operation === 'save_draft') {
    const record = mergePatch(requireSubmission(input), input.patch);
    const recoveryTokenRef = input.recovery_token_ref ?? record.recovery_token_ref;
    if (!recoveryTokenRef?.trim()) {
      throw new StructuredSelectionValidationError([{
        field: 'recovery_token_ref',
        code: 'recovery_token_required',
        message: 'partial drafts require a durable recovery token',
        recovery: { action: 'issue_recovery_token' },
      }]);
    }
    const answerFactWrites = buildAnswerWrites(record, input.intake_answers, input.owners);
    return result({
      ...record,
      intake_answer_fact_refs: uniqueText([
        ...record.intake_answer_fact_refs,
        ...answerFactWrites.map((write) => write.address_label),
      ]),
      submission_state: 'draft',
      recovery_token_ref: recoveryTokenRef,
    }, answerFactWrites, false);
  }

  if (input.operation === 'cancel') {
    return result({ ...normalizedRecord(requireSubmission(input)), submission_state: 'cancelled' });
  }

  if (input.operation === 'revise') {
    return result({ ...mergePatch(requireSubmission(input), input.patch), submission_state: 'revision' });
  }

  const record = validateStructuredSelectionSubmission(
    mergePatch(requireSubmission(input), input.patch),
    input.owners,
  );
  if (input.operation === 'validate') return result({ ...record, submission_state: 'valid' });

  if (!['not_required', 'resolved'].includes(record.subject_identity.duplicate_resolution.status)) {
    throw new StructuredSelectionValidationError([{
      field: 'subject_identity.duplicate_resolution',
      code: 'duplicate_identity_unresolved',
      message: 'Resolve the duplicate identity before requesting capacity.',
      recovery: { action: 'resolve_duplicate' },
    }]);
  }

  const answerFactWrites = buildAnswerWrites(record, input.intake_answers, input.owners);
  return result({
    ...record,
    intake_answer_fact_refs: uniqueText([
      ...record.intake_answer_fact_refs,
      ...answerFactWrites.map((write) => write.address_label),
    ]),
    submission_state: 'submitted',
  }, answerFactWrites, true);
}

const STRUCTURED_SELECTION_FIELDS: PublishNode[] = [
  ['subject_identity', 'subject-identity'],
  ['catalog_entry_id', 'catalog-entry-reference'],
  ['selected_session_refs', 'session-reference-selection'],
  ['ranked_preferences', 'ranked-preference-list'],
  ['contact_preferences', 'contact-preference-record'],
].map(([id, valueKind]) => ({
  id,
  props: {
    form_field: {
      label: id.replaceAll('_', ' '),
      value_kind: valueKind,
      required: id !== 'contact_preferences',
    },
  },
}));

export function publishStructuredSelectionForm(
  surfaceId: string,
  surface: AnyRecord = {},
): PublishFormResult {
  return publishForm({
    surfaceId,
    surface,
    ownerAction: {
      owner_ref: 'package::request-intake::structured-selection-preferences',
      operations: [
        'open',
        'save_draft',
        'recover_draft',
        'validate',
        'submit',
        'revise',
        'cancel',
        'resolve_duplicate',
      ],
    },
    root: {
      id: `${surfaceId}:structured-session-selection`,
      props: { text: 'Session selection preferences' },
      children: STRUCTURED_SELECTION_FIELDS,
    },
  });
}
