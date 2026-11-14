import {
  descriptorList,
  type GenericActionDescriptor,
  type GenericTermsProjectionConfig,
  type GenericTermsProjectionInput,
  type JsonValue,
  validateGenericTermsInput,
} from './activation-pricing-config.ts';

export type ProjectedTermsStatus = 'loading' | 'empty' | 'ready' | 'stale' | 'error';

export type ProjectedTermsField = {
  id: string;
  label: string;
  value: JsonValue;
  formatted: string;
};

export type ProjectedTermsOption = {
  id: string;
  title: string;
  summary: string;
  fields: ProjectedTermsField[];
  relationships: Array<{ role: string; target: string; params?: Record<string, JsonValue> }>;
  emphasis: boolean;
};

export type ProjectedTermsAction = {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  target?: string;
  method?: string;
  params?: Record<string, JsonValue>;
  process?: {
    id: string;
    target: string;
    method: string;
    params?: Record<string, JsonValue>;
  };
};

export type GenericTermsProjection = {
  kind: 'generic-terms-projection';
  id: string;
  status: ProjectedTermsStatus;
  title: string;
  summary: string;
  freshnessLabel?: string;
  issue?: { category: string; label: string };
  options: ProjectedTermsOption[];
  actions: ProjectedTermsAction[];
  diagnostics: {
    recordCount: number;
    actionCount: number;
    descriptorCount: number;
  };
};

export type ActivationPricingProjection = GenericTermsProjection;

const DEFAULT_CONFIG: GenericTermsProjectionConfig = {
  id: 'activation-pricing',
  title: 'Activation pricing',
  summary: 'Compare available terms before continuing.',
  emptyLabel: 'No terms are published yet.',
  loadingLabel: 'Loading terms.',
  errorLabel: 'Terms could not load. Nothing was changed.',
  staleLabel: 'Terms may be out of date.',
};

export function buildActivationPricingProjection(
  input: GenericTermsProjectionInput,
  config: GenericTermsProjectionConfig = DEFAULT_CONFIG,
): ActivationPricingProjection {
  return buildGenericTermsProjection(input, config);
}

export function buildGenericTermsProjection(
  rawInput: GenericTermsProjectionInput,
  config: GenericTermsProjectionConfig = DEFAULT_CONFIG,
): GenericTermsProjection {
  const input = validateGenericTermsInput(rawInput);
  const records = [...(input.records ?? [])].sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
  );
  const status = resolveStatus(input.status, records);
  const options =
    status === 'loading' || records.length === 0
      ? []
      : records.map((record) => {
          const descriptors = descriptorList(record.descriptors, input.descriptors);
          return {
            id: record.id,
            title: record.title ?? record.id,
            summary: record.summary ?? '',
            fields: descriptors
              .filter((descriptor) => Object.hasOwn(record.fields ?? {}, descriptor.id))
              .map((descriptor) => {
                const value = record.fields?.[descriptor.id] ?? null;
                return {
                  id: descriptor.id,
                  label: descriptor.label,
                  value,
                  formatted: formatValue(value, descriptor.format),
                };
              }),
            relationships: (record.relationships ?? []).map(({ role, target, params }) => ({ role, target, params })),
            emphasis: record.emphasis === true,
          };
        });
  const actions = [...(input.actions ?? []), ...records.flatMap((record) => record.actions ?? [])].map(projectAction);
  const projection = {
    kind: 'generic-terms-projection' as const,
    id: input.id ?? config.id,
    status,
    title: input.title ?? config.title ?? config.id,
    summary: input.summary ?? summaryFor(status, config),
    freshnessLabel: input.freshnessLabel,
    issue: input.issue,
    options,
    actions,
    diagnostics: {
      recordCount: records.length,
      actionCount: actions.length,
      descriptorCount:
        Object.keys(input.descriptors ?? {}).length +
        records.reduce((count, record) => count + Object.keys(record.descriptors ?? {}).length, 0),
    },
  };
  if (typeof console !== 'undefined') {
    console.info('[activation-pricing] terms projection built', {
      status: projection.status,
      recordCount: projection.diagnostics.recordCount,
      actionCount: projection.diagnostics.actionCount,
    });
  }
  return projection;
}

export function projectionBytesForReader(projection: GenericTermsProjection): string {
  return JSON.stringify(projection);
}

export function readProjectionBytesForReact(bytes: string): GenericTermsProjection {
  return JSON.parse(bytes) as GenericTermsProjection;
}

export function readProjectionBytesForJscore(bytes: string): GenericTermsProjection {
  return JSON.parse(bytes) as GenericTermsProjection;
}

function resolveStatus(
  status: GenericTermsProjectionInput['status'],
  records: NonNullable<GenericTermsProjectionInput['records']>,
): ProjectedTermsStatus {
  if (status) return status;
  return records.length === 0 ? 'empty' : 'ready';
}

function summaryFor(status: ProjectedTermsStatus, config: GenericTermsProjectionConfig): string {
  if (status === 'empty') return config.emptyLabel ?? '';
  if (status === 'loading') return config.loadingLabel ?? '';
  if (status === 'error') return config.errorLabel ?? '';
  if (status === 'stale') return config.staleLabel ?? '';
  return config.summary ?? '';
}

function projectAction(action: GenericActionDescriptor): ProjectedTermsAction {
  const enabled = action.enabled === true && Boolean(action.target && action.method);
  const disabledReason = enabled ? undefined : action.disabledReason ?? 'This action is not available.';
  return {
    id: action.id,
    label: action.label,
    enabled,
    disabledReason,
    target: action.target,
    method: action.method,
    params: action.params,
    process: action.process,
  };
}

function formatValue(value: JsonValue, format?: string): string {
  if (value === null) return '';
  if (format === 'integer' && typeof value === 'number') return Math.trunc(value).toLocaleString('en-US');
  if (format === 'number' && typeof value === 'number') return value.toLocaleString('en-US');
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
