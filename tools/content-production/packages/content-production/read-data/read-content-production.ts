import {
  evidencePayloads,
  readEvidenceProjection,
  type EvidenceProjection,
} from '../../../../record-voice-and-meetings/read-data/content-media-evidence';
import contentProductionData from '@/packages/content-production/derived-formats.json';

export type ContentProductionChoice = {
  id: string;
  label: string;
  description?: string;
};

export type ContentProductionCountChoice = ContentProductionChoice & {
  value: number;
};

export type ContentProductionFormatChoice = ContentProductionChoice & {
  contentType: string;
};

export type ContentProductionCompositionCatalog = {
  schema: string;
  knowledgeSources: ContentProductionChoice[];
  contentPillars: ContentProductionChoice[];
  destinations: ContentProductionChoice[];
  variationAxes: ContentProductionChoice[];
  variationCounts: ContentProductionCountChoice[];
  formats: ContentProductionFormatChoice[];
  crossPollination: { minInputs: number; maxInputs: number; maxFormats: number };
};

export type ContentProductionCompositionDescriptor = {
  schema: string;
  knowledge_source_id: string;
  content_format_id: string;
  content_format_ids?: string[];
  content_pillar_ids: string[];
  destination_ids: string[];
  variation_count: number;
  variation_axis_ids: string[];
  source_ids: string[];
  cross_pollination: boolean;
};

export type ContentProductionRunProfile = {
  kind?: string;
  profile_id?: string;
  label?: string;
  sources?: unknown[];
  requested_outputs?: unknown[];
  execution_definition_id?: string;
  metadata?: ContentProductionRunProfileMetadata;
};

export type ContentProductionRunProfileMetadata = Record<string, unknown> & {
  selection_inputs?: ContentProductionSelectionInput[];
  source_inputs?: ContentProductionSourceInput[];
};

export type ContentProductionRun = {
  run_id?: string;
  prompt_text?: string;
  sources?: unknown[];
  requested_outputs?: unknown[];
  execution_definition_id?: string;
  requested_at?: string;
};

export type ContentProductionStatus = {
  run_id?: string;
  state?: string;
  message?: string;
  observed_at?: string;
};

export type ContentProductionOutput = {
  run_id?: string;
  step_id?: string;
  definition_id?: string;
  output?: unknown;
  completed_at?: string;
};

export type ContentProductionError = {
  run_id?: string;
  step_id?: string;
  code?: string;
  message?: string;
  observed_at?: string;
};

export type ContentProductionStatusVocabularyEntry = {
  state?: string;
  label?: string;
  detail?: string;
  action_label?: string;
  tone?: string;
  is_terminal?: boolean;
  is_error?: boolean;
};

export type ContentProductionStatusVocabulary = {
  vocabulary_id?: string;
  entries?: ContentProductionStatusVocabularyEntry[];
  fallback?: ContentProductionStatusVocabularyEntry;
  setup?: ContentProductionStatusVocabularyEntry;
  needs_source?: ContentProductionStatusVocabularyEntry;
  needs_selection?: ContentProductionStatusVocabularyEntry;
  needs_prompt?: ContentProductionStatusVocabularyEntry;
  ready?: ContentProductionStatusVocabularyEntry;
  submitting?: ContentProductionStatusVocabularyEntry;
  output_present_state?: string;
  error_present_state?: string;
};

export type ContentProductionActionInvocationDescriptor = {
  descriptor_id?: string;
  owner_action_target?: string;
  owner_action_id?: string;
  default_execution_definition_id?: string;
};

export type ContentProductionEvidence = {
  projection: EvidenceProjection;
  runProfiles: ContentProductionRunProfile[];
  runs: ContentProductionRun[];
  statuses: ContentProductionStatus[];
  outputs: ContentProductionOutput[];
  errors: ContentProductionError[];
  statusVocabularies: ContentProductionStatusVocabulary[];
  actionInvocationDescriptors: ContentProductionActionInvocationDescriptor[];
};

export type ContentProductionSelectionInput = {
  input_id?: string;
  label?: string;
  evidence_package?: string;
  role?: string;
  id_path?: string;
  label_paths?: string[];
  metadata_key?: string;
  metadata_id_key?: string;
};

export type ContentProductionSelectionOption = {
  id: string;
  label: string;
  input: ContentProductionSelectionInput;
  raw: Record<string, unknown>;
};

export type ContentProductionSourceInput = ContentProductionSelectionInput & {
  source_ref_path?: string;
};

export type ContentProductionSourceOption = ContentProductionSelectionOption & {
  input: ContentProductionSourceInput;
  sourceRef: Record<string, unknown>;
};

export type ContentProductionStep = {
  kind: string;
  tone: string;
  label: string;
  detail: string;
  actionLabel: string;
  canSubmit: boolean;
  needsSource: boolean;
  needsSelection: boolean;
  hasPrompt: boolean;
  rawState: string;
};

export type DeriveContentProductionStepInput = {
  evidence: ContentProductionEvidence;
  runProfile: ContentProductionRunProfile | null;
  promptText: string;
  needsSource: boolean;
  selectedSource?: ContentProductionSourceOption | null;
  needsSelection: boolean;
  selectionInput?: ContentProductionSelectionInput | null;
  selectedSelection?: ContentProductionSelectionOption | null;
  isSubmitting?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function choices(value: unknown): ContentProductionChoice[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return { id: entry, label: entry.replaceAll('_', ' ') };
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string') return null;
    return {
      id: entry.id,
      label: entry.label,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    };
  }).filter((entry): entry is ContentProductionChoice => entry !== null);
}

export function readContentProductionCompositionCatalog(
  raw: unknown = contentProductionData,
): ContentProductionCompositionCatalog {
  const document = isRecord(raw) ? raw : {};
  const composition = isRecord(document.composition) ? document.composition : {};
  const crossPollination = isRecord(composition.cross_pollination) ? composition.cross_pollination : {};
  const formats = Array.isArray(document.formats) ? document.formats : [];
  return {
    schema: typeof composition.schema === 'string' ? composition.schema : 'content-production.content-composition/v1',
    knowledgeSources: choices(composition.knowledge_sources),
    contentPillars: choices(composition.content_pillars),
    destinations: choices(composition.destinations),
    variationAxes: choices(composition.variation_axes),
    variationCounts: choices(composition.variation_counts).map((choice) => {
      const source = (composition.variation_counts as unknown[]).find((entry) => isRecord(entry) && entry.id === choice.id);
      return { ...choice, value: isRecord(source) && Number.isInteger(source.value) ? Number(source.value) : Number(choice.id) || 1 };
    }),
    formats: formats.map((entry) => isRecord(entry)
      && typeof entry.id === 'string'
      && typeof entry.label === 'string'
      && typeof entry.content_type === 'string'
      ? { id: entry.id, label: entry.label, contentType: entry.content_type }
      : null).filter((entry): entry is ContentProductionFormatChoice => entry !== null),
    crossPollination: {
      minInputs: Number.isInteger(crossPollination.min_inputs) ? Number(crossPollination.min_inputs) : 2,
      maxInputs: Number.isInteger(crossPollination.max_inputs) ? Number(crossPollination.max_inputs) : 32,
      maxFormats: Number.isInteger(crossPollination.max_formats) ? Number(crossPollination.max_formats) : 4,
    },
  };
}

export const contentProductionCompositionCatalog = readContentProductionCompositionCatalog();

export function readContentProductionEvidence(raw: unknown): ContentProductionEvidence {
  const projection = readEvidenceProjection(raw, 'content-production');
  return {
    projection,
    runProfiles: evidencePayloads<ContentProductionRunProfile>(projection, 'run_profiles'),
    runs: evidencePayloads<ContentProductionRun>(projection, 'runs'),
    statuses: evidencePayloads<ContentProductionStatus>(projection, 'statuses'),
    outputs: evidencePayloads<ContentProductionOutput>(projection, 'outputs'),
    errors: evidencePayloads<ContentProductionError>(projection, 'errors'),
    statusVocabularies: evidencePayloads<ContentProductionStatusVocabulary>(projection, 'status_vocabularies'),
    actionInvocationDescriptors: evidencePayloads<ContentProductionActionInvocationDescriptor>(projection, 'action_invocation_descriptors'),
  };
}

export function firstRunProfile(profiles: readonly ContentProductionRunProfile[]): ContentProductionRunProfile | null {
  return profiles.find((profile) => typeof profile.execution_definition_id === 'string') ?? profiles[0] ?? null;
}

function valueAtPath(value: unknown, path: unknown): unknown {
  if (typeof path !== 'string' || path.length === 0) return value;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (isRecord(current)) return current[segment];
    return undefined;
  }, value);
}

function textAtPath(value: unknown, path: unknown): string | null {
  const found = valueAtPath(value, path);
  return typeof found === 'string' && found.trim().length > 0 ? found.trim() : null;
}

function selectionInputList(
  inputs: unknown,
): ContentProductionSelectionInput[] {
  return Array.isArray(inputs)
    ? inputs.filter((input): input is ContentProductionSelectionInput => isRecord(input))
    : [];
}

function payloadsForInput(
  projection: EvidenceProjection,
  input: ContentProductionSelectionInput,
): Record<string, unknown>[] {
  return (projection.rowsByRole[input.role ?? ''] ?? [])
    .filter((row) => !row.source_package || row.source_package === input.evidence_package)
    .map((row) => row.payload)
    .filter((payload): payload is Record<string, unknown> => isRecord(payload));
}

export function firstSelectionInput(
  profile: ContentProductionRunProfile | null,
): ContentProductionSelectionInput | null {
  return selectionInputList(profile?.metadata?.selection_inputs)[0] ?? null;
}

export function sourceInputs(
  profile: ContentProductionRunProfile | null,
): ContentProductionSourceInput[] {
  return selectionInputList(profile?.metadata?.source_inputs);
}

export function readSelectionOptions(
  rawEvidenceRows: unknown,
  input: ContentProductionSelectionInput | null,
): ContentProductionSelectionOption[] {
  if (!input?.evidence_package || !input.role || !input.id_path) return [];
  const projection = readEvidenceProjection(rawEvidenceRows, input.evidence_package);
  return payloadsForInput(projection, input)
    .map((payload) => {
      const id = textAtPath(payload, input.id_path);
      if (!id) return null;
      const label = (input.label_paths ?? [])
        .map((path) => textAtPath(payload, path))
        .find((value): value is string => !!value) ?? id;
      return { id, label, input, raw: payload };
    })
    .filter((option): option is ContentProductionSelectionOption => option !== null);
}

export function readSourceOptions(
  rawEvidenceRows: unknown,
  input: ContentProductionSourceInput | null,
): ContentProductionSourceOption[] {
  if (!input?.evidence_package || !input.role || !input.id_path) return [];
  const projection = readEvidenceProjection(rawEvidenceRows, input.evidence_package);
  return payloadsForInput(projection, input)
    .map((payload) => {
      const id = textAtPath(payload, input.id_path);
      const sourceRef = valueAtPath(payload, input.source_ref_path ?? 'source_ref');
      if (!id || !isRecord(sourceRef)) return null;
      const label = (input.label_paths ?? [])
        .map((path) => textAtPath(payload, path))
        .find((value): value is string => !!value) ?? id;
      return { id, label, input, raw: payload, sourceRef };
    })
    .filter((option): option is ContentProductionSourceOption => option !== null);
}

function latestByTime<T extends { observed_at?: string; completed_at?: string }>(
  values: readonly T[],
): T | null {
  return [...values].sort((left, right) => {
    const leftTime = Date.parse(left.observed_at ?? left.completed_at ?? '');
    const rightTime = Date.parse(right.observed_at ?? right.completed_at ?? '');
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  })[0] ?? null;
}

function normalizedState(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function firstStatusVocabulary(evidence: ContentProductionEvidence): ContentProductionStatusVocabulary {
  return evidence.statusVocabularies[0] ?? {};
}

export function firstActionInvocationDescriptor(
  evidence: ContentProductionEvidence,
): ContentProductionActionInvocationDescriptor | null {
  return evidence.actionInvocationDescriptors[0] ?? null;
}

function vocabularyEntry(
  vocabulary: ContentProductionStatusVocabulary,
  rawState: string,
  fallbackKey?: keyof ContentProductionStatusVocabulary,
): ContentProductionStatusVocabularyEntry {
  const stateKey = normalizedState(rawState);
  const matched = (vocabulary.entries ?? []).find((entry) => normalizedState(entry.state) === stateKey);
  const namedFallback = fallbackKey && isRecord(vocabulary[fallbackKey]) ? vocabulary[fallbackKey] as ContentProductionStatusVocabularyEntry : null;
  return matched ?? namedFallback ?? vocabulary.fallback ?? {};
}

function stepFromEntry(
  rawState: string,
  entry: ContentProductionStatusVocabularyEntry,
  canSubmit: boolean,
  needsSource: boolean,
  needsSelection: boolean,
  hasPrompt: boolean,
  message?: string,
): ContentProductionStep {
  const stateKey = normalizedState(rawState) || 'not_started';
  return {
    kind: stateKey,
    rawState: stateKey,
    tone: typeof entry.tone === 'string' ? entry.tone : 'neutral',
    label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : 'Needs review',
    detail: typeof message === 'string' && message.trim()
      ? message.trim()
      : typeof entry.detail === 'string' ? entry.detail : '',
    actionLabel: typeof entry.action_label === 'string' && entry.action_label.trim() ? entry.action_label.trim() : 'Start',
    canSubmit,
    needsSource,
    needsSelection,
    hasPrompt,
  };
}

export function deriveContentProductionStep({
  evidence,
  runProfile,
  promptText,
  needsSource,
  selectedSource,
  needsSelection,
  selectedSelection,
  isSubmitting = false,
}: DeriveContentProductionStepInput): ContentProductionStep {
  const vocabulary = firstStatusVocabulary(evidence);
  const hasPrompt = promptText.trim().length > 0;
  const latestError = latestByTime(evidence.errors);
  if (latestError) {
    const state = vocabulary.error_present_state ?? latestError.code ?? 'error_present';
    return stepFromEntry(state, vocabularyEntry(vocabulary, state), hasPrompt, needsSource, needsSelection, hasPrompt, latestError.message);
  }

  const latestStatus = latestByTime(evidence.statuses);
  const state = normalizedState(latestStatus?.state);
  const stateEntry = vocabularyEntry(vocabulary, state);
  if (stateEntry.is_error) return stepFromEntry(state, stateEntry, hasPrompt, needsSource, needsSelection, hasPrompt, latestStatus?.message);
  const latestOutput = latestByTime(evidence.outputs);
  if (latestOutput) {
    const outputState = (vocabulary.output_present_state ?? state) || 'output_present';
    return stepFromEntry(outputState, vocabularyEntry(vocabulary, outputState), hasPrompt, needsSource, needsSelection, hasPrompt);
  }
  if (stateEntry.is_terminal || stateEntry.is_error) return stepFromEntry(state, stateEntry, hasPrompt, needsSource, needsSelection, hasPrompt, latestStatus?.message);
  if (state) return stepFromEntry(state, stateEntry, false, needsSource, needsSelection, hasPrompt, latestStatus?.message);
  if (isSubmitting) return stepFromEntry('submitting', vocabularyEntry(vocabulary, 'submitting', 'submitting'), false, needsSource, needsSelection, hasPrompt);

  if (!runProfile) {
    return stepFromEntry('setup', vocabularyEntry(vocabulary, 'setup', 'setup'), false, needsSource, needsSelection, hasPrompt);
  }

  if (needsSource && !selectedSource) {
    return stepFromEntry('needs_source', vocabularyEntry(vocabulary, 'needs_source', 'needs_source'), false, true, needsSelection, hasPrompt);
  }

  if (needsSelection && !selectedSelection) {
    const entry = vocabularyEntry(vocabulary, 'needs_selection', 'needs_selection');
    return stepFromEntry('needs_selection', entry, false, needsSource, true, hasPrompt);
  }

  if (!hasPrompt) {
    return stepFromEntry('needs_prompt', vocabularyEntry(vocabulary, 'needs_prompt', 'needs_prompt'), false, needsSource, needsSelection, false);
  }

  return stepFromEntry('ready', vocabularyEntry(vocabulary, 'ready', 'ready'), true, needsSource, needsSelection, true);
}
