// packages/group/show/BoardTidinessReadout.tsx
//
// BOARD TIDINESS READOUT — the surface for the `board-tidiness` leaf. It shows a board's tidiness SCORE (a
// 0–100% gauge, green→amber→red) plus a per-kind issue count and a worst-first issue list; clicking an issue
// selects the cards it concerns (so the user can jump to a mess and hit the existing one-click fix —
// spread-out for overlaps, align for near-misses). BLIND to what a check means (L090): it renders whatever
// `analyzeTidiness` returns, so a new detector row auto-appears with zero readout code.
//
// `ui`-only chrome (Container/Text — L065-safe). Connectors are excluded (edges have no footprint to tidy).

import React from 'react';
import { Badge, Button, Card, Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import {
  analyzeTidiness,
  TIDINESS_DETECTORS,
  type TidinessReport,
  type TidyDetectorDef,
} from '../do-work/board-tidiness';

/** Run the tidiness analysis over the board's non-connector items. */
export function boardTidiness(items: readonly BoardItem[], detectors: readonly TidyDetectorDef[] = TIDINESS_DETECTORS): TidinessReport {
  const rects = items
    .filter((i) => !itemIsConnector(i))
    .map((i) => ({ memberId: i.memberId, x: i.x, y: i.y, w: i.w, h: i.h }));
  return analyzeTidiness(rects, detectors);
}

/** Score band → colour + word (green ≥ 0.85, amber ≥ 0.6, else red). */
export function tidinessBand(score: number): { color: string; ink: string; label: string } {
  if (score >= 0.85) return { color: '#dcfce7', ink: '#166534', label: 'Tidy' };
  if (score >= 0.6) return { color: '#fef9c3', ink: '#854d0e', label: 'A bit messy' };
  return { color: '#fee2e2', ink: '#991b1b', label: 'Messy' };
}

/** Human label for a detector id (from the catalog), else the id. */
function kindLabel(id: string, detectors: readonly TidyDetectorDef[]): string {
  return detectors.find((d) => d.id === id)?.label ?? id;
}

export interface BoardTidinessReadoutProps {
  readonly items: readonly BoardItem[];
  readonly detectors?: readonly TidyDetectorDef[];
  /** Select the cards an issue concerns (jump-to / then fix). */
  readonly onPickIssue?: (memberIds: readonly string[]) => void;
  /** One-click fix: separate every overlapping card. Shown only when there ARE overlaps to fix. */
  readonly onTidyUp?: () => void;
  /** Max issue rows to list (default 6). */
  readonly maxIssues?: number;
}

/** The readout panel — score gauge + per-kind counts + worst-first issue list. Blind to detector meaning. */
export function BoardTidinessReadout({ items, detectors = TIDINESS_DETECTORS, onPickIssue, onTidyUp, maxIssues = 6 }: BoardTidinessReadoutProps) {
  const report = boardTidiness(items, detectors);
  const pct = Math.round(report.score * 100);
  const band = tidinessBand(report.score);
  const overlapCount = report.countsByKind['overlap'] ?? 0;
  // R49: name the cards an issue concerns — never a raw `m-<uuid>`. A card with no title
  // reads as "Untitled card", the same word the rest of the board uses (L114/L118).
  const labelOf = (id: string): string => items.find((it) => it.memberId === id)?.text?.trim() || 'Untitled card';
  return (
    // R49: a THEME surface (Card/popover token), not a hardcoded white div — a white card
    // was jarring on the dark studio and off the screen-look tokens every other panel uses.
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="sm" style={{ minWidth: 240 }} data-tidiness>
        <Container layout="horizontal" gap="sm" alignItems="center">
          {/* The score band stays a semantic colour (green/amber/red) — it's the meaning,
              not chrome — but sits in a self-contained pill so it reads on any theme. */}
          <Container style={{ background: band.color, borderRadius: 999, padding: '4px 12px' }}>
            <Text variant="body" weight="bold" style={{ color: band.ink }} data-tidiness-score>{pct}%</Text>
          </Container>
          <Text variant="body-sm" weight="semibold" style={{ color: band.ink }}>{band.label}</Text>
          {onTidyUp && overlapCount > 0 ? (
            <Container style={{ marginLeft: 'auto' }}>
              <Button variant="secondary" size="xs" onClick={onTidyUp} data-tidiness-fix aria-label="Tidy up — separate every overlapping card">Tidy up</Button>
            </Container>
          ) : null}
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center" style={{ flexWrap: 'wrap' }}>
          {detectors.map((d) => (
            <Badge key={d.id} variant="secondary" size="sm">
              {report.countsByKind[d.id] ?? 0} {kindLabel(d.id, detectors).toLowerCase()}
            </Badge>
          ))}
        </Container>
        {report.issues.length === 0 ? (
          <Text variant="body-xs" color="muted">Nothing to tidy — every card is clear and aligned.</Text>
        ) : (
          <Container layout="vertical" gap="xs">
            {report.issues.slice(0, maxIssues).map((iss, i) => (
              <Container
                key={i}
                role="button"
                onClick={onPickIssue ? () => onPickIssue(iss.memberIds) : undefined}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 8px', borderRadius: 6, background: 'var(--glass-bg-subtle)', cursor: onPickIssue ? 'pointer' : 'default' }}
              >
                <Text variant="body-xs">{iss.detail ?? kindLabel(iss.detectorId, detectors)}</Text>
                <Text variant="body-xs" color="muted">{iss.memberIds.map(labelOf).join(' · ')}</Text>
              </Container>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
}
