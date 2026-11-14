import { readRecordWorkModel, type ModelAction, type ReadRecordWorkModelInput, type RecordWorkModel } from '../read-data/record-work-model';

export type SectionKind =
  | 'header'
  | 'summaryStrip'
  | 'detailGroup'
  | 'optionGroup'
  | 'actionRail'
  | 'confirmation'
  | 'outcome'
  | 'problemList'
  | 'empty'
  | 'loading'
  | 'error';

export type Intent = 'primary' | 'neutral' | 'quiet' | 'destructive';

export interface ActionControlDescriptor {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  intent: Intent;
}

export interface DetailRowDescriptor {
  id: string;
  label: string;
  value: string;
  tone?: string;
}

export interface OptionCardDescriptor {
  id: string;
  title: string;
  priceText?: string;
  lines: DetailRowDescriptor[];
  action: ActionControlDescriptor;
  selected?: boolean;
}

export interface ProofDisclosureDescriptor {
  summaryLabel: string;
  rows: readonly DetailRowDescriptor[];
}

export type Section =
  | { kind: 'header'; title: string; explanation: string; freshness: { label: string; tone?: string } }
  | { kind: 'summaryStrip'; stats: readonly DetailRowDescriptor[] }
  | { kind: 'detailGroup'; title: string; rows: readonly DetailRowDescriptor[]; disclosure?: ProofDisclosureDescriptor }
  | { kind: 'optionGroup'; title: string; options: readonly OptionCardDescriptor[] }
  | { kind: 'actionRail'; actions: readonly ActionControlDescriptor[] }
  | { kind: 'confirmation'; title: string; explanation: string; rows: readonly DetailRowDescriptor[]; confirm: ActionControlDescriptor; cancel: ActionControlDescriptor }
  | { kind: 'outcome'; tone: string; title: string; detail?: string }
  | { kind: 'problemList'; problems: readonly { id: string; title: string; detail?: string }[] }
  | { kind: 'empty'; title: string; explanation: string }
  | { kind: 'loading'; title: string }
  | { kind: 'error'; title: string; detail?: string; retry?: ActionControlDescriptor };

export interface PlanLifecycleSurfaceDescriptor {
  schema: 'plan-lifecycle.surface-descriptor.v1';
  revision: string;
  sections: readonly Section[];
  proof: {
    source: 'record-work-model';
    projectionId: string;
    descriptorCount: number;
    sourceRecordCount: number;
  };
}

function controlFor(action: ModelAction): ActionControlDescriptor {
  const intent = typeof action.input?.intent === 'string' ? action.input.intent : 'neutral';
  return {
    id: action.id,
    label: action.label,
    enabled: !action.blocked,
    disabledReason: action.blockedReason,
    intent: isIntent(intent) ? intent : 'neutral',
  };
}

function isIntent(value: string): value is Intent {
  return value === 'primary' || value === 'neutral' || value === 'quiet' || value === 'destructive';
}

function rowsFromModel(model: RecordWorkModel): DetailRowDescriptor[] {
  const item = model.items[0];
  return (item?.values ?? []).map((value) => ({
    id: value.fieldId,
    label: value.label,
    value: value.text,
  }));
}

export function buildPlanLifecycleSurfaceDescriptor(model: RecordWorkModel): PlanLifecycleSurfaceDescriptor {
  const sections: Section[] = [
    {
      kind: 'header',
      title: model.title,
      explanation: model.items[0]?.title ?? model.empty.detail,
      freshness: { label: model.items.length ? 'Ready' : 'Waiting' },
    },
  ];

  if (model.blockers.length) {
    sections.push({
      kind: 'problemList',
      problems: model.blockers.map((blocker) => ({
        id: blocker.ruleId,
        title: blocker.message,
        detail: blocker.severity,
      })),
    });
  }

  if (!model.items.length) {
    sections.push({ kind: 'empty', title: model.empty.title, explanation: model.empty.detail });
  } else {
    sections.push({ kind: 'summaryStrip', stats: model.summary.map((value) => ({ id: value.fieldId, label: value.label, value: value.text })) });
    sections.push({ kind: 'detailGroup', title: model.items[0]!.title, rows: rowsFromModel(model) });
  }

  if (model.actions.length) {
    sections.push({ kind: 'actionRail', actions: model.actions.map(controlFor) });
  }

  return {
    schema: 'plan-lifecycle.surface-descriptor.v1',
    revision: model.revision,
    sections,
    proof: {
      source: 'record-work-model',
      projectionId: model.projectionId,
      descriptorCount: model.proof.descriptorCount,
      sourceRecordCount: model.proof.sourceRecordCount,
    },
  };
}

export function readPlanLifecycleSurfaceDescriptor(input: ReadRecordWorkModelInput): PlanLifecycleSurfaceDescriptor {
  return buildPlanLifecycleSurfaceDescriptor(readRecordWorkModel(input));
}
