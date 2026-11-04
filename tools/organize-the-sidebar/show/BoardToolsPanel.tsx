// packages/group/show/BoardToolsPanel.tsx
//
// The board TOOLS rail — ONE mountable product surface composing the selection + report subsystems over a
// SHARED selection state: the SelectionSummaryBar (b199, a live "what did I just select?" chip readout), the
// optional SmartSetStrip (b200, save the current facet query as a re-resolving smart set + re-apply a saved one
// with its live count), the ReportPanel (b190, insights → click a row to select its cards), the SelectionMenu
// (b188, grow/shrink/same-attribute/invert), and the SelectionCombineBar (b189, pin-and-combine). They all read
// the board's `selectedIds` and call back through the same `onSelect`, so a report row's selection flows into the
// menu's grow, whose result flows into the combine — one coherent tool. Stateless: the board owns
// `{selected, pinned}` + the smart-set store. This is the single dock point the board mounts.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Button, Container, Icon, Text } from '../../ui';
import { ChevronDown, X } from 'lucide-react';
import type { BoardItem } from '../read-data/group-board-model';
import type { FacetExtractors } from '../read-data/facet-filter';
import type { StoredSmartSet, SmartQuery } from '../read-data/saved-smart-set';
import { ReportPanel } from './ReportPanel';
import { SelectionMenu } from './SelectionMenu';
import { SelectionCombineBar } from './SelectionCombineBar';
import { SelectionSummaryBar } from './SelectionSummaryBar';
import { SmartSetStrip } from './SmartSetStrip';

export interface BoardToolsPanelProps {
  readonly items: readonly BoardItem[];
  readonly selectedIds: readonly string[];
  readonly pinnedIds: readonly string[] | null;
  /** Replace the board selection (called by the report rows AND the selection actions AND combine). */
  readonly onSelect: (ids: string[]) => void;
  readonly onPin: () => void;
  readonly onUnpin: () => void;
  readonly onCombine: (ids: string[]) => void;
  /** Saved smart sets (re-resolving queries) — when supplied with their extractors + handlers, the strip shows
   *  each set's live match count and applies it on click. Omitted → no smart-set strip (the rail is unchanged). */
  readonly smartSets?: readonly StoredSmartSet[];
  readonly unavailableSmartSets?: readonly { memberId: string; name: string }[];
  readonly smartSetExtractors?: FacetExtractors<BoardItem>;
  readonly smartSetFacetLabels?: Readonly<Record<string, string>>;
  readonly currentSmartQuery?: SmartQuery;
  readonly onReplaceSmartQuery?: (memberId: string, expected: SmartQuery, replacement: SmartQuery) => Promise<string | null>;
  readonly onSaveSmartSet?: () => void;
  readonly onApplySmartSet?: (ids: string[]) => void;
  /** Focus the board on a saved set's query (dim non-matching) — enables the strip's Focus mode when supplied. */
  readonly onFocusSmartSet?: (query: SmartQuery) => void;
  /** Archive (remove) a saved set by memberId — adds a remove affordance to each chip when supplied. */
  readonly onArchiveSmartSet?: (memberId: string) => void;
  readonly archivedSmartSets?: readonly StoredSmartSet[];
  readonly onRestoreSmartSet?: (memberId: string) => void;
  readonly onRenameSmartSet?: (memberId: string, name: string) => void;
  /** Human-scale controls for the current item. Kept open because these are the
   *  likely next actions after selecting something. */
  readonly primaryControls?: React.ReactNode;
  /** Batch/layout controls. Collapsed until requested so selection does not
   *  produce a second toolbar across the canvas. */
  readonly batchControls?: React.ReactNode;
  /** Relationship readout for the primary selected item. */
  readonly relationControls?: React.ReactNode;
  /** Clear the shared board selection and dismiss this inspector. */
  readonly onClear?: () => void;
}

function InspectorSection({ label, defaultOpen = false, children }: { readonly label: string; readonly defaultOpen?: boolean; readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Container layout="vertical" gap="xs">
      <Button variant="ghost" size="sm" fullWidth aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Container layout="horizontal" justifyContent="between" alignItems="center" width="full">
          <Text variant="body-sm" weight="medium">{label}</Text>
          <Container style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 140ms ease' }}>
            <Icon icon={ChevronDown} size="xs" />
          </Container>
        </Container>
      </Button>
      {open ? <Container layout="vertical" gap="xs" padding="xs" style={{ paddingTop: 0 }}>{children}</Container> : null}
    </Container>
  );
}

/** The single selection inspector — immediate controls first, deeper analysis
 *  behind disclosure. It replaces the former right rail + bottom bulk bar +
 *  bottom-left relation card collision. */
export function BoardToolsPanel({ items, selectedIds, pinnedIds, onSelect, onPin, onUnpin, onCombine, smartSets, unavailableSmartSets, smartSetExtractors, smartSetFacetLabels, currentSmartQuery, onReplaceSmartQuery, onSaveSmartSet, onApplySmartSet, onFocusSmartSet, onArchiveSmartSet, archivedSmartSets, onRestoreSmartSet, onRenameSmartSet, primaryControls, batchControls, relationControls, onClear }: BoardToolsPanelProps) {
  return (
    <Container layout="vertical" gap="md" padding="sm" aria-label="Board tools">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Text variant="label">Selection</Text>
        {onClear ? (
          <Button variant="ghost" size="icon-xs" aria-label="Close selection inspector" onClick={onClear}>
            <Icon icon={X} size="xs" />
          </Button>
        ) : null}
      </Container>
      <SelectionSummaryBar items={items} selectedIds={selectedIds} />
      {primaryControls ? <InspectorSection label="Basic">{primaryControls}</InspectorSection> : null}
      {relationControls ? <InspectorSection label="Relations">{relationControls}</InspectorSection> : null}
      {batchControls ? <InspectorSection label="Arrange & batch">{batchControls}</InspectorSection> : null}
      <InspectorSection label="Analyze" defaultOpen={selectedIds.length === 0}>
        {smartSets && smartSetExtractors && onApplySmartSet ? (
          <SmartSetStrip sets={smartSets} unavailableSets={unavailableSmartSets} items={items} extractors={smartSetExtractors} facetLabels={smartSetFacetLabels} currentQuery={currentSmartQuery} onReplaceQuery={onReplaceSmartQuery} onSaveCurrent={onSaveSmartSet} onApply={onApplySmartSet} onFocus={onFocusSmartSet} onArchive={onArchiveSmartSet} archivedSets={archivedSmartSets} onRestore={onRestoreSmartSet} onRename={onRenameSmartSet} />
        ) : null}
        <ReportPanel items={items} onSelect={onSelect} />
        <SelectionMenu items={items} selectedIds={selectedIds} onSelect={onSelect} />
        <SelectionCombineBar selectedIds={selectedIds} pinnedIds={pinnedIds} onPin={onPin} onUnpin={onUnpin} onCombine={onCombine} />
      </InspectorSection>
    </Container>
  );
}
