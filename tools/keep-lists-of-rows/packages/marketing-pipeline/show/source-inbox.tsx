// package-set://bitfield-studio/packages/marketing-pipeline/show/source-inbox.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The source-inbox region: a left rail listing the REAL upstream connections
// that feed the records (each record's relationships, deduped), grouped by their
// origin. Selecting an entry opens the record it belongs to. Composed from the
// shared CollectionSidebar primitive — search, collapse, and resize come for
// free. When there are no connections the rail renders nothing (the surface
// drops the column), never a fake "0 sources" shell (L117).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. REAL DATA ONLY: every entry is an actual relationship on an actual record
//    (from inboxEntries) — nothing synthesized.
// 2. Refs never leak (L098): origin/role/target are humanized before display;
//    the rail shows words a person reads, never a raw ref or namespace.
// 3. Composes shared `ui` only (CollectionSidebar, Card, Text) — no raw HTML,
//    no className (L065/L066).
// 4. Self-contained: owns its own search + panel state; the surface passes only
//    the entries, the current selection, and a select handler.
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
import type { CoordinationInboxEntry } from '../read-data/coordination-metrics';
import { humanizeOrigin, humanizeToken } from './humanize';

export interface SourceInboxProps {
  entries: CoordinationInboxEntry[];
  /** The record id currently selected in the workbench (for highlight). */
  selectedRecordId: string | undefined;
  /** Open the record an entry belongs to. */
  onSelectRecord: (recordId: string) => void;
}

interface InboxItem extends CoordinationInboxEntry {
  /** Pre-humanized primary line (the connected thing). */
  primary: string;
  /** Pre-humanized role line. */
  roleLabel: string;
  /** Pre-humanized origin (group label and caption). */
  originLabel: string;
}

function toItem(entry: CoordinationInboxEntry): InboxItem {
  return {
    ...entry,
    primary: humanizeToken(entry.targetRef) || humanizeToken(entry.role) || 'Connection',
    roleLabel: humanizeToken(entry.role),
    originLabel: entry.ownerRef ? humanizeOrigin(entry.ownerRef) : 'Sources',
  };
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

/** Left rail of the real upstream connections feeding the records. */
export function SourceInbox({ entries, selectedRecordId, onSelectRecord }: SourceInboxProps): React.ReactElement | null {
  const [panelState, setPanelState] = React.useState<CollectionSidebarPanelState>(
    DEFAULT_COLLECTION_SIDEBAR_PANEL_STATE,
  );
  const [search, setSearch] = React.useState('');

  const items = React.useMemo(() => entries.map(toItem), [entries]);
  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.primary} ${item.roleLabel} ${item.originLabel}`.toLowerCase().includes(query),
    );
  }, [items, search]);
  const groups = React.useMemo(() => groupByOrigin(filtered), [filtered]);

  if (entries.length === 0) return null;

  return (
    <CollectionSidebar<InboxItem>
      title="Sources"
      count={entries.length}
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
            <Text variant="caption" color="muted">{item.roleLabel}</Text>
          </Container>
        </Card>
      )}
    />
  );
}

export default SourceInbox;
