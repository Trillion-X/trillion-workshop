// package-set://bitfield-studio/packages/product-access/show/map-product-access-surface.ts

import type {
  ProductAccessActionDescriptor,
  ProductAccessItem,
  ProductAccessView,
} from '../read-data/access-control-projection';
import type {
  ActionControlDescriptor,
  ItemCardDescriptor,
  ProductAccessSurfaceDescriptor,
  Section,
} from './product-access-surface-descriptor';

function actionControl(action: ProductAccessActionDescriptor, index: number): ActionControlDescriptor {
  return {
    id: action.id,
    label: action.label,
    enabled: action.enabled,
    disabledReason: action.disabledReason,
    intent: index === 0 ? 'primary' : 'neutral',
    ownerAction: action,
  };
}

function itemCard(item: ProductAccessItem): ItemCardDescriptor {
  const actions = item.actions.map(actionControl);
  return {
    id: item.id,
    title: item.title,
    statusLabel: item.status.label,
    statusTone: item.status.tone,
    statusRank: item.status.rank,
    lines: item.lines,
    primaryAction: actions[0],
    secondaryActions: actions.slice(1),
  };
}

function itemDetail(item: ProductAccessItem): Section {
  const actions = item.actions.map(actionControl);
  return {
    kind: 'itemDetail',
    itemId: item.id,
    title: item.title,
    rows: [
      { id: 'status', label: 'Status', value: item.status.label },
      ...item.lines,
    ],
    proof: item.verificationRows.length
      ? { summaryLabel: 'Verification details', rows: item.verificationRows }
      : undefined,
    actions,
  };
}

function summarySection(view: ProductAccessView): Section {
  const actionCount = view.accessItems.reduce((total, item) => total + item.actions.length, 0);
  return {
    kind: 'summaryStrip',
    stats: [
      { id: 'item-count', label: 'Items', value: String(view.accessItems.length) },
      { id: 'action-count', label: 'Actions', value: String(actionCount) },
      { id: 'freshness', label: 'Freshness', value: view.freshness.label, tone: view.freshness.tone },
    ],
  };
}

function headerSection(view: ProductAccessView): Section {
  return {
    kind: 'header',
    title: view.title,
    explanation: view.freshness.stale
      ? view.freshness.disabledReason || view.freshness.label
      : view.freshness.label,
    freshness: {
      label: view.freshness.label,
      tone: view.freshness.tone,
    },
  };
}

export function mapProductAccessViewToSurfaceDescriptor(view: ProductAccessView): ProductAccessSurfaceDescriptor {
  const sections: Section[] = [headerSection(view), summarySection(view)];

  if (view.projectionProblems.length) {
    sections.push({ kind: 'problemList', problems: view.projectionProblems });
  }

  if (!view.accessItems.length) {
    sections.push({
      kind: 'empty',
      title: 'Nothing to show',
      explanation: 'No access records were supplied.',
    });
  } else {
    sections.push({ kind: 'itemList', items: view.accessItems.map(itemCard) });
    sections.push(itemDetail(view.accessItems[0]));
  }

  return {
    schema: 'product-access.surface-descriptor.v1',
    title: view.title,
    sections,
  };
}
