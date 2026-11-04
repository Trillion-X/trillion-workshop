// packages/group/show/SavedReportsStrip.tsx
//
// The saved-reports strip — the product surface for `saved-report-store` (b181). Save the current report to the
// library and re-open a saved one (which restores its pickers via `controlsFromDescriptor`). A thin config of
// the generic `SavedItemsStrip` (b193, L100 — the strip mechanism lives once). Renders as the `ReportPanel`
// header slot. The board owns the saved list + persistence (the store writes are board-side, b181).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { SavedItemsStrip, type SavedItem } from './SavedItemsStrip';

/** A saved report as the strip sees it — just an id + display name (the descriptor lives in the store). */
export type SavedReportChip = SavedItem;

export interface SavedReportsStripProps {
  readonly saved: readonly SavedReportChip[];
  /** Save the CURRENT report to the library. */
  readonly onSave: () => void;
  /** Re-open a saved report by id (the board restores its descriptor into the pickers). */
  readonly onOpen: (id: string) => void;
}

/** "Save report" + a chip per saved report — the report configuration of `SavedItemsStrip`. */
export function SavedReportsStrip({ saved, onSave, onOpen }: SavedReportsStripProps) {
  return <SavedItemsStrip title="Saved reports" saveLabel="Save report" openVerb="open" items={saved} onSave={onSave} onOpen={onOpen} />;
}
