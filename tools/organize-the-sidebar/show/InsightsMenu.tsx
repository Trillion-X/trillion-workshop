// packages/group/show/InsightsMenu.tsx
//
// The INSIGHTS menu — ONE toolbar entry point for the board's read-only insight lenses, instead of N crowding
// buttons (L063: eliminate the whole "one button per lens" category; L118: the toolbar stops growing with every
// new lens). A BLIND (L090) menu over `InsightLens` DATA descriptors: it names no lens, folds whatever available
// descriptors it is handed. Clicking "Insights" lists the AVAILABLE lenses (each descriptor self-gates via
// `available`); picking one opens that lens's own panel (the descriptor's `render`), which owns its close. Adding
// a lens is one descriptor row, ZERO menu code (L069). Renders nothing when no lens is available (L118).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useRef, useState } from 'react';
import { AnchoredOverlay, Button, Card, Container, Icon, Text } from '../../ui';
import { Sparkles } from 'lucide-react';
// namedGroupCount must be IMPORTED here, not only re-exported below: an
// `export { x } from '…'` clause is a pure re-export that creates NO local
// binding, so using x in this module is a runtime ReferenceError the moment
// the component renders (live studio crash, 2026-07-10 — "This screen hit a
// problem: namedGroupCount is not defined" on the whole Vision Board pane).
import { foldRowGroups, namedGroupCount } from '../read-data/grouped-rows';

/** One insight lens as the menu sees it: a label, whether it applies to the current board, and how to render its
 *  panel (the descriptor returns its OWN positioned panel + wires its own actions; `onClose` collapses it).
 *  `group` is an OPTIONAL DATA label that sections the menu (b217) — the menu names no group, it just folds by
 *  whatever the descriptors declare. A menu with a single group (or none) renders flat; sections appear only when
 *  more than one named group is actually available, so headers never clutter a short list (L118). */
export interface InsightLens {
  readonly key: string;
  readonly label: string;
  readonly available: boolean;
  readonly group?: string;
  readonly render: (onClose: () => void) => JSX.Element;
}

export interface InsightsMenuProps {
  readonly lenses: readonly InsightLens[];
  /** Controlled open-lens key. When provided together with `onActiveKeyChange`, the OWNER holds which lens is
   *  open, so a second surface (e.g. the board Command Palette) can open a lens too (L069: one registry, two
   *  drivers). Omit both for the uncontrolled internal-state behavior the harnesses use. */
  readonly activeKey?: string | null;
  readonly onActiveKeyChange?: (key: string | null) => void;
}

/** Fold the available lenses into their declared groups — a thin projection of the SHARED
 *  `foldRowGroups` fold (read-data/grouped-rows; the Custom-actions popover sections through
 *  the same fold): first-seen group order, within-group declared order, ungrouped under `''`
 *  (rendered header-less). Exported for unit testing the fold + the header gate. */
export function groupLenses(available: readonly InsightLens[]): Array<{ readonly group: string; readonly lenses: InsightLens[] }> {
  return foldRowGroups(available, (l) => l.group).map(({ group, rows }) => ({ group, lenses: rows }));
}

/** The shared L118 header gate (ONE implementation in read-data/grouped-rows): section
 *  headers earn their pixels only when more than one NAMED group is present. Re-exported so
 *  existing consumers/tests keep their import site. */
export { namedGroupCount } from '../read-data/grouped-rows';

/** The "Insights" button → a picker of available lenses → the chosen lens's panel. */
export function InsightsMenu({ lenses, activeKey, onActiveKeyChange }: InsightsMenuProps): JSX.Element | null {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [internalOpenKey, setInternalOpenKey] = useState<string | null>(null);
  // Controlled when the owner passes `activeKey` — then the owner's value is the truth and every open/close is
  // reported through `onActiveKeyChange`; otherwise the menu owns `internalOpenKey` (uncontrolled).
  const controlled = activeKey !== undefined;
  const openKey = controlled ? activeKey : internalOpenKey;
  const setOpenKey = (key: string | null): void => {
    onActiveKeyChange?.(key);
    if (!controlled) setInternalOpenKey(key);
  };
  const available = lenses.filter((l) => l.available);
  if (available.length === 0) return null;
  const active = available.find((l) => l.key === openKey) ?? null;
  const groups = groupLenses(available);
  // Section headers earn their pixels only when more than one NAMED group is present (L118); otherwise the menu
  // renders flat under the single "Insights" title.
  const showHeaders = namedGroupCount(groups) > 1;
  const lensButton = (l: InsightLens): JSX.Element => (
    <Button key={l.key} variant="ghost" size="sm" aria-label={`Open ${l.label}`} onClick={() => { setOpenKey(l.key); setMenuOpen(false); }}>
      {l.label}
    </Button>
  );
  return (
    <>
      <Button ref={anchorRef} variant="ghost" size="sm" aria-label="Open board insights" aria-haspopup="dialog" aria-expanded={menuOpen && !active} onClick={() => { setMenuOpen((v) => !v); setOpenKey(null); }}>
        <Icon icon={Sparkles} size="sm" /> Insights
      </Button>
      {/* R48: ANCHORED to the Insights button (same AnchoredOverlay anatomy every other header
          popover uses — On board / Look), not a hardcoded right:12/top:56 corner. AnchoredOverlay
          owns the outside-click/Escape dismiss the bespoke absolute container lacked. */}
      <AnchoredOverlay anchorRef={anchorRef} open={menuOpen && !active} onDismiss={() => setMenuOpen(false)}>
        <Card variant="popover" padding="md">
          <Container layout="vertical" gap="xs" style={{ minWidth: 180 }} aria-label="Board insights">
            {showHeaders
              ? groups.map(({ group, lenses: groupLensesList }) => (
                  <Container key={group || '_ungrouped'} layout="vertical" gap="xs">
                    {group ? <Text variant="label">{group}</Text> : null}
                    {groupLensesList.map(lensButton)}
                  </Container>
                ))
              : (
                <>
                  <Text variant="label">Insights</Text>
                  {available.map(lensButton)}
                </>
              )}
          </Container>
        </Card>
      </AnchoredOverlay>
      {active ? active.render(() => setOpenKey(null)) : null}
    </>
  );
}
