// packages/group/show/BoardActionsButton.tsx
//
// The header "Custom actions" button + its anchored popover. The board can accumulate DOZENS of custom /
// AI action tools (R10 action-as-DATA); rendering them all inline floods the header row so it no longer fits
// and the board canvas below is pushed off-screen (a user's report: "the top header doesn't scroll so I can't
// reach the vision board"). This collapses the whole flood behind ONE button: click it → a popover whose
// SEARCH (top) and "+ Create new action" (below it) are PINNED (never scroll) while only the action list below
// scrolls. The built-in item tools (Note/Shape/Image/…) stay inline in the header; only the open-ended custom
// action set moves in here.

import React, { useMemo, useRef, useState } from 'react';
import { AnchoredOverlay, Button, Icon, Input, Container, Text } from '../../ui/index.ts';
import { Sparkles, Plus, Search, X, Pencil } from 'lucide-react';
import { ShelfToolButton, type ShelfEntry } from './item-renderers.tsx';
import { foldRowGroups, namedGroupCount } from '../read-data/grouped-rows.ts';

export interface BoardActionsButtonProps {
  /** The custom / producer-backed action tools (the flood we pull out of the header row). */
  readonly actions: ReadonlyArray<ShelfEntry>;
  /** Run one action (the panel's ONE add path — ask → fire → pending → poll). */
  readonly onRun: (tool: ShelfEntry) => void;
  /** Open the new-action authoring editor (the same one the ⌘K "New action…" row opens). */
  readonly onCreateNew: () => void;
  /** Archive (soft-delete) one removable action through the owning live write path.
   *  Absent → no Remove affordance renders anywhere (read-only surface). Only rows
   *  carrying a `removalRef` (a resolvable live write address) get the control. */
  readonly onRemove?: (tool: ShelfEntry) => void;
  /** Open the SAME authoring editor prefilled with this action (edit-in-place).
   *  Absent → no Edit affordance. Gated exactly like Remove: only rows with a
   *  `removalRef` (a live write address to edit AT) get the pencil. */
  readonly onEdit?: (tool: ShelfEntry) => void;
  /** The ARCHIVED (soft-deleted) actions — the durable way back once the transient
   *  Undo notice is gone. Present + non-empty → a collapsed "Removed (N)" section
   *  renders at the list tail (BoardSwitcherMenu's collapsed-archive anatomy);
   *  expanding lists each with a Restore control. Absent/empty → nothing (L118). */
  readonly archived?: ReadonlyArray<{ readonly label: string; readonly restore: () => void }>;
}

/**
 * One action row: the ghost menu button (transparent until hover) + its trailing Edit /
 * Remove ghost affordances. The trailing controls are HOVER-REVEALED (visibility, not
 * mount — the aria surface stays stable for assistive tech and probes): 80 rows × 2
 * always-visible icons reads as noise (L118); every other popover reveals row controls
 * on hover. Controls render only for rows whose record has a live write address
 * (removalRef) AND when the host supplies the path — same gate as before.
 */
function ActionRow({
  tool,
  onRun,
  onEdit,
  onRemove,
}: {
  readonly tool: ShelfEntry;
  readonly onRun: (tool: ShelfEntry) => void;
  readonly onEdit?: (tool: ShelfEntry) => void;
  readonly onRemove?: (tool: ShelfEntry) => void;
}) {
  const [hover, setHover] = useState(false);
  const controlStyle: React.CSSProperties = hover ? {} : { visibility: 'hidden' };
  return (
    <Container
      style={{ flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setHover(true)}
      onBlurCapture={() => setHover(false)}
    >
      {/* appearance="menu": rows are transparent until hover (ghost + size:menu) —
          the same option-row anatomy every other popover uses, NOT the filled
          toolbar chip (a user's 2026-07-09 report: each row had its own background). */}
      <Container style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
        <ShelfToolButton tool={tool} appearance="menu" onAdd={onRun} />
      </Container>
      {onEdit && tool.removalRef ? (
        <Container style={controlStyle}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit ${tool.label}`}
            onClick={() => onEdit(tool)}
          >
            <Icon icon={Pencil} size="xs" />
          </Button>
        </Container>
      ) : null}
      {onRemove && tool.removalRef ? (
        <Container style={controlStyle}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${tool.label}`}
            onClick={() => onRemove(tool)}
          >
            <Icon icon={X} size="xs" />
          </Button>
        </Container>
      ) : null}
    </Container>
  );
}

/**
 * A header button that opens a searchable, scrollable popover of the board's custom actions, with a pinned
 * search and a pinned "Create new action" row. Rendered only when there is ≥1 custom action (L118: no dead
 * control — the always-present "New action" header button remains the create path when the board has none yet).
 */
export function BoardActionsButton({ actions, onRun, onCreateNew, onRemove, onEdit, archived }: BoardActionsButtonProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Search matches the label OR the section name ("translate" surfaces the whole
    // Translate section) — the section is DATA on the record, never enumerated here.
    return q
      ? actions.filter((a) => a.label.toLowerCase().includes(q) || (a.section ?? '').toLowerCase().includes(q))
      : actions;
  }, [actions, query]);
  // ~80 flat rows are unscannable (a user's flood report) — fold them under their record-
  // declared `section` DATA via the SHARED grouping fold (same one the Insights menu uses,
  // L069). Headers earn their pixels only when >1 named section is present (L118).
  const groups = useMemo(() => foldRowGroups(filtered, (a) => a.section), [filtered]);
  const showHeaders = namedGroupCount(groups) > 1;

  if (actions.length === 0) return null;

  const close = () => {
    setOpen(false);
    setQuery('');
    setShowArchived(false);
  };

  return (
    <>
      <Button
        ref={anchorRef}
        variant="secondary"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Custom actions (${actions.length})`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Sparkles} size="sm" /> Custom actions
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} onDismiss={close}>
        {/* Self-surfaced, self-capped column: search + create are flex-shrink:0 (pinned); only the list
            (flex:1 + minHeight:0 + overflowY:auto) scrolls. Capping our own height keeps the overlay's own
            scroller idle, so the pinned rows never scroll away. */}
        <Container
          layout="vertical"
          style={{
            width: 300,
            maxHeight: '60vh',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--black-rich)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.36)',
            overflow: 'hidden',
          }}
        >
          {/* PINNED: search */}
          <Container padding="sm" style={{ flexShrink: 0 }}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search actions"
              aria-label="Search custom actions"
              icon={<Icon icon={Search} size="sm" />}
              autoFocus
            />
          </Container>
          {/* PINNED: create new action */}
          <Container padding="sm" style={{ flexShrink: 0, paddingTop: 0 }}>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={() => {
                onCreateNew();
                close();
              }}
            >
              <Icon icon={Plus} size="sm" /> Create new action
            </Button>
          </Container>
          {/* SCROLLABLE: the action list. Geometry is INLINE-STYLED (display/direction/gap/shrink) — not
              utility classes: this popover must not depend on the compiled global-css record, because a stale
              record silently drops newly-authored classes (see build-global-css.mjs header), which collapsed
              this list to block flow and rendered every row as an overlapping SMEAR (a user's 2026-07-09
              screenshot). Each row wrapper is flexShrink:0 + width:100% so a capped column overflows into the
              scroller — never into shrink, never into inline wrap. */}
          <Container
            padding="sm"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              paddingTop: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              rowGap: 4,
            }}
          >
            {filtered.length === 0 ? (
              <Text variant="body-xs" color="muted">No actions match “{query}”.</Text>
            ) : (
              groups.map(({ group, rows }) => (
                <Container key={group || '_ungrouped'} style={{ flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', rowGap: 4 }}>
                  {showHeaders && group ? (
                    <Container style={{ flexShrink: 0, paddingTop: 6, paddingLeft: 8 }}>
                      <Text variant="label">{group}</Text>
                    </Container>
                  ) : null}
                  {rows.map((tool) => (
                    <ActionRow
                      key={tool.label}
                      tool={tool}
                      onRun={(t) => {
                        onRun(t);
                        close();
                      }}
                      {...(onEdit ? { onEdit: (t: ShelfEntry) => { onEdit(t); close(); } } : {})}
                      {...(onRemove ? { onRemove } : {})}
                    />
                  ))}
                </Container>
              ))
            )}
            {/* Collapsed archive tail — the DURABLE way back once the transient Undo
                notice is gone (the switcher's collapsed "Archived (N)" anatomy). Only
                when archived rows exist AND no search is active (a query scopes the
                list to live matches; the archive is not searchable content). */}
            {archived && archived.length > 0 && query.trim() === '' ? (
              <Container style={{ flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', rowGap: 4, paddingTop: 6 }}>
                <Button
                  variant="ghost"
                  size="menu"
                  aria-label={`Removed actions (${archived.length})`}
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  Removed ({archived.length})
                </Button>
                {showArchived
                  ? archived.map((row) => (
                      <Container key={row.label} style={{ flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }}>
                        <Container style={{ flex: 1, minWidth: 0 }}>
                          <Text variant="body-xs" color="muted" truncate>{row.label}</Text>
                        </Container>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Restore ${row.label}`}
                          onClick={() => row.restore()}
                        >
                          Restore
                        </Button>
                      </Container>
                    ))
                  : null}
              </Container>
            ) : null}
          </Container>
        </Container>
      </AnchoredOverlay>
    </>
  );
}
