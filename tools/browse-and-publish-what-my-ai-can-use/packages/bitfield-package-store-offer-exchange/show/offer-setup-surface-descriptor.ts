export type SectionKind =
  | 'header'
  | 'summaryStrip'
  | 'offerSummary'
  | 'termsList'
  | 'checklist'
  | 'problemList'
  | 'reviewCommit'
  | 'actionOutcome'
  | 'proofDisclosure'
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

export interface KeyValueLine {
  id: string;
  label: string;
  value: string;
  tone?: string;
}

export type Section =
  | { kind: 'header'; title: string; explanation: string; freshness: { label: string; tone?: string } }
  | { kind: 'summaryStrip'; stats: Array<{ id: string; label: string; value: string; tone?: string }> }
  | { kind: 'offerSummary'; title: string; statusLabel: string; statusTone?: string; statusRank?: number; lines: KeyValueLine[] }
  | { kind: 'termsList'; title?: string; items: Array<{ id: string; label: string; value?: string; selected?: boolean; tone?: string }> }
  | { kind: 'checklist'; title?: string; items: Array<{ id: string; label: string; stateLabel: string; stateTone?: string; rank?: number; detail?: string }> }
  | { kind: 'problemList'; title?: string; problems: Array<{ id: string; title: string; detail?: string; tone?: string }> }
  | { kind: 'reviewCommit'; title?: string; summaryRows: KeyValueLine[]; primaryAction: ActionControlDescriptor; secondaryActions?: ActionControlDescriptor[] }
  | { kind: 'actionOutcome'; tone?: string; title: string; detail?: string }
  | { kind: 'proofDisclosure'; summaryLabel: string; rows: Array<{ id: string; label: string; value: string }> }
  | { kind: 'empty'; title: string; explanation: string; primaryAction?: ActionControlDescriptor }
  | { kind: 'loading'; title: string }
  | { kind: 'error'; title: string; detail?: string; retry?: ActionControlDescriptor };

export interface OfferSetupSurfaceDescriptor {
  sections: Section[];
}
