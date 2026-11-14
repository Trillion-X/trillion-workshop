// package-set://bitfield-studio/packages/product-access/show/product-access-surface-descriptor.ts

import type {
  ProductAccessActionDescriptor,
  ProductAccessLine,
  ProductAccessProofRow,
} from '../read-data/access-control-projection';

export type SectionKind =
  | 'header'
  | 'summaryStrip'
  | 'itemList'
  | 'itemDetail'
  | 'actionOutcome'
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
  ownerAction: ProductAccessActionDescriptor;
}

export interface ItemCardDescriptor {
  id: string;
  title: string;
  statusLabel: string;
  statusTone?: string;
  statusRank?: number;
  lines: ProductAccessLine[];
  primaryAction?: ActionControlDescriptor;
  secondaryActions: ActionControlDescriptor[];
}

export type Section =
  | {
      kind: 'header';
      title: string;
      explanation: string;
      freshness: { label: string; tone?: string };
    }
  | {
      kind: 'summaryStrip';
      stats: Array<{ id: string; label: string; value: string; tone?: string }>;
    }
  | { kind: 'itemList'; items: ItemCardDescriptor[] }
  | {
      kind: 'itemDetail';
      itemId: string;
      title: string;
      rows: ProductAccessLine[];
      proof?: { summaryLabel: string; rows: ProductAccessProofRow[] };
      actions: ActionControlDescriptor[];
    }
  | { kind: 'actionOutcome'; tone: string; title: string; detail?: string }
  | { kind: 'problemList'; problems: Array<{ id: string; title: string; detail?: string }> }
  | { kind: 'empty'; title: string; explanation: string }
  | { kind: 'loading'; title: string }
  | { kind: 'error'; title: string; detail?: string; retry?: ActionControlDescriptor };

export interface ProductAccessSurfaceDescriptor {
  schema: 'product-access.surface-descriptor.v1';
  title: string;
  sections: Section[];
}
