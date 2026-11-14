// package-set://bitfield-studio/packages/customer-support/show/source-inbox.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// WorkItemContextView — a left context rail listing the REAL upstream
// connections that feed the records (each record's relationRefs, flattened),
// grouped by their origin. Selecting an entry opens the record it belongs to.
// Composed from the shared CollectionSidebar primitive, so search, collapse, and
// resize come for free. When there are no connections the rail renders nothing
// (the surface drops the column), never a fake "0 sources" shell (L117).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. REAL DATA ONLY: every entry is an actual relation ref on an actual record —
//    nothing synthesized.
// 2. Refs never leak (L098): origin/connection are humanized before display.
// 3. Composes shared `ui` only (CollectionSidebar, Card, Text) — no raw HTML,
//    no className (L065/L066).
// 4. Self-contained: owns its own search + panel state; the surface passes only
//    the records, the current selection, and a select handler.
//
// =============================================================================

import React from 'react';
import {
  Card,
  CollectionSidebar,
  Container,
  DEFAULT_COLLECTION_SIDEBAR_PANEL_STATE,
  Text,
  type CollectionSidebarGroup,
  type CollectionSidebarPanelState,
} from '@/packages/ui';
import { Inbox } from 'lucide-react';
import type { SupportRecord } from './workspace-types';
import { humanizeOrigin, humanizeToken } from './humanize';

interface InboxItem {
  /** Stable key for this connection row. */
  id: string;
  /** The record this connection belongs to. */
  recordId: string;
  /** Pre-humanized primary line (the connected thing). */
  primary: string;
  /** Pre-humanized record label (secondary line). */
  recordLabel: string;
  /** Pre-humanized origin (group label). */
  originLabel: string;
}

/** Flatten each record's relation refs into selectable context entries. */
export function inboxItemsFromRecords(records: SupportRecord[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const record of records) {
    record.relationRefs.forEach((ref, index) => {
      items.push({
        id: `${record.id}:${ref}:${index}`,
        recordId: record.id,
        primary: humanizeToken(ref) || 'Connection',
        recordLabel: record.label,
        originLabel: humanizeOrigin(ref) || 'Sources',
      });
    });
  }
  return items;
}

/** Group inbox items by their humanized origin, preserving first-seen order. */
function groupByOrigin(items: InboxItem[]): CollectionSidebarGroup<InboxItem>[] {
  const order: string[] = [];
  const byOrigin = new Map<string, InboxItem[]>();
  for (const item of items) {
    const key = item.originLabel;
    if (!byOrigin.has(key)) {
      byOrigin.set(key, []);
      order.push(key);
    }
    byOrigin.get(key)!.push(item);
  }
  return order.map((key) => ({ id: key, label: key, items: byOrigin.get(key)! }));
}

export interface SourceInboxProps {
  records: SupportRecord[];
  /** The record id currently selected in the workbench (for highlight). */
  selectedRecordId: string | undefined;
  /** Open the record an entry belongs to. */
  onSelectRecord: (recordId: string) => void;
}

/** Left rail of the real upstream connections feeding the records. */
export function SourceInbox({ records, selectedRecordId, onSelectRecord }: SourceInboxProps): React.ReactElement | null {
  const [panelState, setPanelState] = React.useState<CollectionSidebarPanelState>(
    DEFAULT_COLLECTION_SIDEBAR_PANEL_STATE,
  );
  const [search, setSearch] = React.useState('');

  const items = React.useMemo(() => inboxItemsFromRecords(records), [records]);
  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.primary} ${item.recordLabel} ${item.originLabel}`.toLowerCase().includes(query),
    );
  }, [items, search]);
  const groups = React.useMemo(() => groupByOrigin(filtered), [filtered]);

  if (items.length === 0) return null;

  return (
    <CollectionSidebar<InboxItem>
      title="Sources"
      count={items.length}
      groups={groups}
      panelState={panelState}
      onPanelStateChange={setPanelState}
      searchValue={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search sources"
      emptyIcon={Inbox}
      emptyLabel="No matching sources"
      minWidth={220}
      maxWidth={320}
      getItemKey={(item) => item.id}
      renderItem={({ item }) => (
        <Card
          variant="nested"
          padding="sm"
          layout="column"
          interactive
          selected={item.recordId === selectedRecordId}
          onClick={() => onSelectRecord(item.recordId)}
        >
          <Text variant="body" truncate>{item.primary}</Text>
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Text variant="caption" color="muted" truncate>{item.recordLabel}</Text>
          </Container>
        </Card>
      )}
    />
  );
}

export default SourceInbox;
