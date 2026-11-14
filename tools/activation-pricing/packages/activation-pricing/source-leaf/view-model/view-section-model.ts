import type { JsonValue } from '../read-data/activation-pricing-config.ts';

export type SectionKind =
  | 'header'
  | 'notice'
  | 'dimension-selector'
  | 'variable-control'
  | 'option-comparison'
  | 'detail-rows'
  | 'action'
  | 'diagnostics';

export type LayoutHint = 'stack' | 'grid' | 'aside' | 'inline';

export type ViewSectionBase<K extends SectionKind, P extends Record<string, unknown>> = {
  id: string;
  kind: K;
  layoutHint?: LayoutHint;
  payload: P;
};

export type ViewActionTargetRef = {
  id: string;
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

export type ViewSection =
  | ViewSectionBase<
      'header',
      {
        title: string;
        summary: string;
        status: string;
        freshnessLabel?: string;
      }
    >
  | ViewSectionBase<
      'notice',
      {
        tone: string;
        label: string;
      }
    >
  | ViewSectionBase<
      'dimension-selector',
      {
        label: string;
        selectedId?: string;
        choices: Array<{ id: string; label: string; disabled?: boolean }>;
      }
    >
  | ViewSectionBase<
      'variable-control',
      {
        label: string;
        value: number;
        min?: number;
        max?: number;
        step?: number;
        help?: string;
      }
    >
  | ViewSectionBase<
      'option-comparison',
      {
        options: Array<{
          id: string;
          title: string;
          summary: string;
          emphasis: boolean;
          fields: Array<{ id: string; label: string; formatted: string }>;
        }>;
      }
    >
  | ViewSectionBase<
      'detail-rows',
      {
        rows: Array<{ id: string; label: string; value: string }>;
      }
    >
  | ViewSectionBase<
      'action',
      {
        actions: Array<{
          id: string;
          label: string;
          enabled: boolean;
          disabledReason?: string;
          targetRef: ViewActionTargetRef;
        }>;
      }
    >
  | ViewSectionBase<
      'diagnostics',
      {
        reference: string;
        counts: {
          records: number;
          actions: number;
          fields: number;
        };
      }
    >;

export type ViewSectionModel = {
  kind: 'view-section-model';
  id: string;
  revision: string;
  sections: ViewSection[];
};

export function viewSectionModelBytes(model: ViewSectionModel): string {
  return JSON.stringify(model);
}

export function readViewSectionModelBytes(bytes: string): ViewSectionModel {
  return JSON.parse(bytes) as ViewSectionModel;
}

