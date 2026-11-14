export type JsonRecord = Record<string, unknown>;

export type SurfaceFieldKind =
  | 'subject'
  | 'status'
  | 'stat'
  | 'detail'
  | 'identifier'
  | 'freshness';

export interface SurfaceSourceDescriptor {
  id: string;
  role?: string;
  dependsOn?: string;
  request?: SurfaceTargetRequestDescriptor;
  result?: {
    rowsPath?: readonly string[];
    subjectPath?: readonly string[];
  };
}

export interface SurfaceTargetRequestDescriptor {
  target: string;
  payload?: JsonRecord;
}

export interface SurfaceFieldDescriptor {
  id: string;
  kind: SurfaceFieldKind;
  label: string;
  source?: string;
  paths?: readonly (readonly string[])[];
  match?: JsonRecord;
  empty?: string;
  priority?: number;
}

export interface SurfaceActionDescriptor {
  id: string;
  slot?: string;
  label: string;
  locus?: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  payload?: JsonRecord;
  input?: JsonRecord;
  copy?: readonly SurfaceActionInputCopy[];
  disabledReason?: string;
  successPath?: readonly string[];
}

export interface SurfaceActionInputCopy {
  key: string;
  from?: string;
  value?: unknown;
}

export interface SurfaceReturnActionStepDescriptor {
  target: string;
  payload?: JsonRecord;
  resultKey?: string;
}

export interface SurfaceReturnActionDescriptor {
  id: string;
  match_query: Record<string, string>;
  payload_fields: Record<string, { query_param: string }>;
  steps: readonly SurfaceReturnActionStepDescriptor[];
  clear_query_params: readonly string[];
  reload_on_success?: boolean;
}

export interface SurfaceDescriptorSet {
  version?: number;
  sources?: readonly SurfaceSourceDescriptor[];
  fields?: readonly SurfaceFieldDescriptor[];
  actions?: readonly SurfaceActionDescriptor[];
  returnActions?: readonly SurfaceReturnActionDescriptor[];
  freshness?: SurfaceFreshnessDescriptor;
  relationships?: readonly JsonRecord[];
  fixtures?: readonly string[];
}

export interface SurfaceFreshnessDescriptor {
  id: string;
  kind?: string;
  label: string;
  state?: string;
}

export interface SurfaceSourceRow {
  sourceId: string;
  role?: string;
  subject?: string;
  data?: unknown;
  rows?: readonly unknown[];
  error?: string;
}

export interface SurfaceField {
  id: string;
  kind: SurfaceFieldKind;
  label: string;
  value: unknown;
  text: string;
  priority: number;
  sourceId?: string;
}

export interface SurfaceAction {
  id: string;
  slot?: string;
  label: string;
  locus: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  payload?: JsonRecord;
  input?: JsonRecord;
  copy: readonly SurfaceActionInputCopy[];
  disabled: boolean;
  disabledReason?: string;
  successPath?: readonly string[];
}

export interface SurfaceFreshness {
  id: string;
  label: string;
  state: string;
  asOf?: string;
}

export interface SurfaceDiagnostic {
  code: string;
  message: string;
  sourceId?: string;
}

export interface SurfaceFixture {
  id: string;
}

export interface SurfaceModel {
  state: 'loading' | 'empty' | 'ready' | 'error';
  fields: readonly SurfaceField[];
  actions: readonly SurfaceAction[];
  freshness: SurfaceFreshness;
  diagnostics: readonly SurfaceDiagnostic[];
  relationships: readonly JsonRecord[];
  fixtures: readonly SurfaceFixture[];
  proof: {
    descriptorCount: number;
    sourceRowCount: number;
  };
}
