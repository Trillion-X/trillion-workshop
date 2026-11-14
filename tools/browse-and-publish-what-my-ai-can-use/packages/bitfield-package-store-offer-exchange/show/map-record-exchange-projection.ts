import type {
  ProjectedAction,
  ProjectedRecord,
  RecordExchangeProjection,
  RecordMap,
  RuleResult,
} from '../read-data/read-record-exchange-projection';
import type {
  ActionControlDescriptor,
  KeyValueLine,
  OfferSetupSurfaceDescriptor,
  Section,
} from './offer-setup-surface-descriptor';

function text(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function humanValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return '';
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const next = text(value);
    if (next) return next;
  }
  return '';
}

function actionControl(action: ProjectedAction | undefined, record: ProjectedRecord): ActionControlDescriptor | undefined {
  if (!action) return undefined;
  return {
    id: action.actionRef,
    label: action.label,
    enabled: action.available,
    disabledReason: action.available ? undefined : firstText(record.rules.filter((rule) => !rule.pass).map((rule) => rule.stateLabel || rule.label)),
    intent: 'primary',
  };
}

function fieldLines(record: ProjectedRecord): KeyValueLine[] {
  return record.fields
    .map((field) => ({
      id: field.fieldRef,
      label: field.label,
      value: humanValue(field.value),
    }))
    .filter((field) => field.value.length > 0);
}

function checklistItems(record: ProjectedRecord) {
  return record.rules.map((rule, index) => ({
    id: rule.ruleRef,
    label: rule.label,
    stateLabel: rule.stateLabel,
    stateTone: rule.stateTone,
    rank: index,
  }));
}

function problemItems(record: ProjectedRecord) {
  return record.rules
    .filter((rule) => !rule.pass)
    .map((rule: RuleResult) => ({
      id: rule.resultRef ?? rule.ruleRef,
      title: rule.label,
      detail: rule.detail,
      tone: 'warning',
    }));
}

function proofRows(record: ProjectedRecord) {
  return record.proofs.map((proof: RecordMap, index) => ({
    id: text(proof.id ?? proof.ref) || `proof:${index + 1}`,
    label: firstText([proof.label, proof.title, proof.kind]),
    value: firstText([proof.summary, proof.detail, proof.result_ref, proof.resultRef]),
  }));
}

function sectionLabel(labels: RecordMap, key: string): string {
  return text(labels[key]);
}

function recordSections(record: ProjectedRecord, labels: RecordMap): Section[] {
  const action = record.actions[0];
  const control = actionControl(action, record);
  const allRulesPass = record.rules.every((rule) => rule.pass);
  const lines = fieldLines(record);
  const sections: Section[] = [
    {
      kind: 'offerSummary',
      title: record.title,
      statusLabel: action?.label ?? record.title,
      statusTone: allRulesPass ? 'success' : 'warning',
      lines,
    },
  ];
  if (record.rules.length > 0) {
    sections.push({
      kind: 'checklist',
      title: sectionLabel(labels, 'checklist'),
      items: checklistItems(record),
    });
  }
  const problems = problemItems(record);
  if (problems.length > 0) {
    sections.push({
      kind: 'problemList',
      title: sectionLabel(labels, 'problems'),
      problems,
    });
  }
  if (control) {
    sections.push({
      kind: 'reviewCommit',
      title: sectionLabel(labels, 'review'),
      summaryRows: lines,
      primaryAction: control,
    });
  }
  const rows = proofRows(record);
  if (rows.length > 0) {
    sections.push({
      kind: 'proofDisclosure',
      summaryLabel: sectionLabel(labels, 'proof'),
      rows,
    });
  }
  return sections;
}

export function mapRecordExchangeProjectionToSurfaceDescriptor(
  projection: RecordExchangeProjection,
): OfferSetupSurfaceDescriptor {
  const projectionDescriptor = projection.descriptors.projections[0];
  const projectionLabel = projectionDescriptor?.label;
  const sectionLabels = projectionDescriptor?.sectionLabels ?? {};
  const recordLabel = projection.descriptors.records[0]?.label;
  const sections: Section[] = [
    {
      kind: 'header',
      title: projectionLabel ?? recordLabel ?? 'Review and send',
      explanation: recordLabel ?? '',
      freshness: { label: 'Current', tone: 'neutral' },
    },
    {
      kind: 'summaryStrip',
      stats: [
        { id: 'records', label: sectionLabel(sectionLabels, 'records_stat'), value: String(projection.records.length) },
        {
          id: 'available-actions',
          label: sectionLabel(sectionLabels, 'available_actions_stat'),
          value: String(projection.records.flatMap((record) => record.actions).filter((action) => action.available).length),
        },
      ],
    },
  ];

  if (projection.records.length === 0) {
    sections.push({
      kind: 'empty',
      title: sectionLabel(sectionLabels, 'empty_title') || projectionLabel || '',
      explanation: sectionLabel(sectionLabels, 'empty_explanation'),
    });
  }
  for (const record of projection.records) sections.push(...recordSections(record, sectionLabels));
  if (projection.diagnostics.length > 0) {
    sections.push({
      kind: 'problemList',
      title: sectionLabel(sectionLabels, 'problems'),
      problems: projection.diagnostics.map((diagnostic, index) => ({
        id: `diagnostic:${index + 1}`,
        title: diagnostic,
        tone: 'warning',
      })),
    });
  }
  return { sections };
}
