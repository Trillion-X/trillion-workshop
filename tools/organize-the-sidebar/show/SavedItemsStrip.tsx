// packages/group/show/SavedItemsStrip.tsx
//
// The generic SAVED-ITEMS strip — the ONE product surface behind every "save the current X and re-open a saved
// one" library in the board: saved reports (b192, saved-report-store) and saved views (b193, board-view-store),
// and any future saved-thing. A save button + a chip per saved item; the labels/verbs are DATA props, so a new
// saved-thing is a configuration, not a new component (L100 — this replaces N near-identical strips with one).
// Blind over the list (L090); collapses to just the save button when nothing is saved (L118). Stateless.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Container, InlineEditText, Text } from '../../ui';

/** A saved item as the strip sees it — an id + display name (the payload lives in its store). */
export interface SavedItem {
  readonly id: string;
  readonly name: string;
  readonly editableName?: string;
  readonly detail?: string;
}

export interface SavedItemsStripProps {
  /** Section heading, e.g. "Saved reports" / "Saved views". */
  readonly title: string;
  /** Save-button label, e.g. "Save report" / "Save view". */
  readonly saveLabel: string;
  /** Verb prefix for a chip's aria-label, e.g. "open" → "open Report 1", "jump to" → "jump to View 1". */
  readonly openVerb: string;
  readonly items: readonly SavedItem[];
  /** Save the CURRENT thing to this library. */
  readonly onSave?: () => void;
  /** Re-open / jump to a saved item by id. */
  readonly onOpen: (id: string) => void;
  /** Remove (archive) a saved item by id. When supplied, each chip gains a small remove affordance; when
   *  omitted, chips are plain (existing single-action consumers are unchanged). */
  readonly onRemove?: (id: string) => void;
  /** Verb for the remove affordance's aria-label, e.g. "remove" → "remove Report 1" (default "remove"). */
  readonly removeVerb?: string;
  readonly onRename?: (id: string, name: string) => void;
  readonly onInspect?: (id: string) => void;
  readonly inspectVerb?: string;
}

/** "<saveLabel>" + a chip per saved item. */
export function SavedItemsStrip({ title, saveLabel, openVerb, items, onSave, onOpen, onRemove, removeVerb = 'remove', onRename, onInspect, inspectVerb = 'Details' }: SavedItemsStripProps) {
  return (
    <Container layout="vertical" gap="xs" aria-label={title}>
      <Container layout="horizontal" gap="xs" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label">{title}</Text>
        {onSave ? <Button variant="ghost" size="sm" aria-label={saveLabel} onClick={onSave}>{saveLabel}</Button> : null}
      </Container>
      {items.length > 0 && (
        <Container layout="horizontal" gap="xs" style={{ flexWrap: 'wrap' }}>
          {items.map((s) =>
            onRemove || onRename || onInspect ? (
              <Container key={s.id} layout="horizontal" gap="xs" style={{ alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%' }}>
                {onRename ? <InlineEditText value={s.editableName ?? s.name} aria-label={`Rename ${s.editableName ?? s.name}`} onCommit={(name) => onRename(s.id, name)} variant="body-xs" /> : null}
                {onRename && s.detail ? <Text variant="body-xs">{s.detail}</Text> : null}
                <Button variant="ghost" size="sm" aria-label={`${openVerb} ${s.name}`} onClick={() => onOpen(s.id)}>
                  {onRename ? openVerb : s.name}
                </Button>
                {onInspect ? <Button variant="ghost" size="sm" aria-label={`${inspectVerb} ${s.editableName ?? s.name}`} onClick={() => onInspect(s.id)}>{inspectVerb}</Button> : null}
                {onRemove ? <Button variant="ghost" size="sm" aria-label={`${removeVerb} ${s.name}`} onClick={() => onRemove(s.id)}>×</Button> : null}
              </Container>
            ) : (
              <Button key={s.id} variant="ghost" size="sm" aria-label={`${openVerb} ${s.name}`} onClick={() => onOpen(s.id)}>
                {s.name}
              </Button>
            ),
          )}
        </Container>
      )}
    </Container>
  );
}
