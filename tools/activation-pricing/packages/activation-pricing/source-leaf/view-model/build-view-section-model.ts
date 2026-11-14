import type { GenericTermsProjection } from '../read-data/activation-pricing-model.ts';
import type { ViewSection, ViewSectionModel } from './view-section-model.ts';

export function buildViewSectionModel(projection: GenericTermsProjection): ViewSectionModel {
  const sections: ViewSection[] = [
    {
      id: `${projection.id}:header`,
      kind: 'header',
      layoutHint: 'stack',
      payload: {
        title: projection.title,
        summary: projection.summary,
        status: projection.status,
        freshnessLabel: projection.freshnessLabel,
      },
    },
  ];

  const noticeLabel = projection.issue?.label ?? (projection.status === 'ready' ? '' : projection.summary);
  if (noticeLabel) {
    sections.push({
      id: `${projection.id}:notice:${projection.status}`,
      kind: 'notice',
      layoutHint: 'stack',
      payload: {
        tone: projection.issue?.category ?? projection.status,
        label: noticeLabel,
      },
    });
  }

  if (projection.options.length > 0) {
    sections.push({
      id: `${projection.id}:options`,
      kind: 'option-comparison',
      layoutHint: projection.options.length > 1 ? 'grid' : 'stack',
      payload: {
        options: projection.options.map((option) => ({
          id: option.id,
          title: option.title,
          summary: option.summary,
          emphasis: option.emphasis,
          fields: option.fields.map((field) => ({
            id: field.id,
            label: field.label,
            formatted: field.formatted,
          })),
        })),
      },
    });
  }

  const detailRows = [
    projection.freshnessLabel
      ? { id: `${projection.id}:freshness`, label: 'Freshness', value: projection.freshnessLabel }
      : null,
  ].filter((row): row is { id: string; label: string; value: string } => row !== null);
  if (detailRows.length > 0) {
    sections.push({
      id: `${projection.id}:details`,
      kind: 'detail-rows',
      layoutHint: 'aside',
      payload: { rows: detailRows },
    });
  }

  if (projection.actions.length > 0) {
    sections.push({
      id: `${projection.id}:actions`,
      kind: 'action',
      layoutHint: 'inline',
      payload: {
        actions: projection.actions.map((action) => ({
          id: action.id,
          label: action.label,
          enabled: action.enabled,
          disabledReason: action.disabledReason,
          targetRef: {
            id: action.id,
            target: action.target,
            method: action.method,
            params: action.params,
            process: action.process,
          },
        })),
      },
    });
  }

  sections.push({
    id: `${projection.id}:diagnostics`,
    kind: 'diagnostics',
    layoutHint: 'stack',
    payload: {
      reference: projection.id,
      counts: {
        records: projection.diagnostics.recordCount,
        actions: projection.diagnostics.actionCount,
        fields: projection.diagnostics.descriptorCount,
      },
    },
  });

  return {
    kind: 'view-section-model',
    id: projection.id,
    revision: `${projection.id}:${projection.status}:${projection.diagnostics.recordCount}:${projection.diagnostics.actionCount}:${projection.diagnostics.descriptorCount}`,
    sections,
  };
}

