// packages/group/show/SharedCapsuleView.tsx
//
// The OPENER: what a share link renders. Given a decoded `ShareCapsule`, it lays every
// board's scoped items out read-only, positioned by their world coords, using the SAME
// `rendererForKind` renderers the live board uses (a note looks like a note, a link card
// like a link card, media like media) — zero renderer duplication (L030). No editing, no
// selection, no interaction: a share is a view.
//
// Engine-independent: the capsule carries all content, so this renders from a link alone
// with no network and no studio. Raw-HTML-free (L065) — Container/Text only.

import { Container, Text } from '../../ui';
import { sanitizeCapsuleHtml } from '../do-work/sanitize-capsule-html';
import { rendererForKind } from './item-renderers';
import { buildConnectorModels, connectorEndpoints } from './connector-models';
import { ConnectorLayer, type ConnectorRect } from './ConnectorLayer';
import { BoardMetricLayer, type MetricPill } from './BoardMetricLayer';
import { BoardDueDateLayer, type DueBadge } from './BoardDueDateLayer';
import { formatValue, isComplete, metricFromRaw, progressPct } from '../read-data/board-metric';
import { dueDateFromRaw, relativeDue } from '../read-data/board-due-date';
import { backgroundById } from './board-backgrounds';
import type { BoardItem } from '../read-data/group-board-model';
import type {
  CapsuleBoard,
  PortableItem,
  ShareCapsule,
} from '../read-data/share-capsule';

/** Reconstruct a full BoardItem from the portable projection (opener-only, read-only).
 *  A capsule arrives inside an untrusted share LINK, and the read-only note renderer feeds
 *  `html` into RichTextEditor's `innerHTML` sink — so the html is SANITIZED here at the trust
 *  boundary (drops script / event handlers / unsafe URLs, keeps safe formatting). This closes
 *  the share-link script-injection path; safe rich-text formatting is preserved intact. */
function toBoardItem(p: PortableItem): BoardItem {
  return {
    memberId: p.memberId,
    nodeRef: { family: 'shared-capsule', parts: { item: p.memberId } },
    kind: p.kind,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    text: p.text,
    html: p.html !== undefined ? sanitizeCapsuleHtml(p.html) : undefined,
    src: p.src,
    // A capsule now carries the whole board tree flat (world coords); a section item renders as a
    // labeled folder box with its real count, its children ride the same list at their coords.
    isSection: p.isSection ?? false,
    childCount: p.childCount ?? 0,
    extra: p.extra ?? {},
  };
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly w: number;
  readonly h: number;
}

function boundingBox(items: readonly PortableItem[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function SharedBoard({ board, now }: { board: CapsuleBoard; now: number }): JSX.Element | null {
  // Partition by SHAPE (endpoints), never kind — a connector is drawn by ConnectorLayer,
  // a node by its renderer. Reuses the live board's exact split (connectorEndpoints, L090).
  const boardItems = board.items.map(toBoardItem);
  const nodes = boardItems.filter((it) => connectorEndpoints(it) === null);
  const connectors = boardItems.filter((it) => connectorEndpoints(it) !== null);
  if (nodes.length === 0) return null;

  // Box + rects from NODES only (connectors carry no geometry), offset to a (0,0) origin so
  // ConnectorLayer's absolute svg (anchored at the parent's top-left) lines up with the cards.
  const box = boundingBox(nodes);
  const rects = new Map<string, ConnectorRect>(
    nodes.map((n) => [n.memberId, { x: n.x - box.minX, y: n.y - box.minY, w: n.w, h: n.h }]),
  );
  const connectorModels = buildConnectorModels(connectors, {
    selectedIds: EMPTY_SET,
    hiddenIds: EMPTY_SET,
    showHidden: true,
  });

  // Goal progress pills — a shared VISION board carries each goal's metric in extra.metric (proven to
  // survive the capsule round-trip); render the SAME on-card progress overlay the live board uses so the
  // recipient sees the goals' progress, not plain cards. Read-only (no open panel). Reuses BoardMetricLayer
  // + the metric leaf (L030/L093 — zero new rendering). Origin-offset rects match the cards above.
  const metricPills: MetricPill[] = nodes.reduce<MetricPill[]>((acc, n) => {
    const metric = metricFromRaw(n.extra?.metric);
    if (metric !== null) {
      acc.push({
        memberId: n.memberId,
        rect: { x: n.x - box.minX, y: n.y - box.minY, w: n.w, h: n.h },
        pct: progressPct(metric),
        value: formatValue(metric),
        complete: isComplete(metric),
      });
    }
    return acc;
  }, []);

  // Goal deadlines — the same on-card due-date badge the live board shows (a plan without deadlines is
  // half a plan). Built from each node's extra.dueDate (proven to survive the capsule) + the relative-time
  // reader, tinted by urgency. `now` is injected (no clock in this pure render path). Reuses
  // BoardDueDateLayer + the due-date leaf (L030/L093). Origin-offset rects match the cards.
  const dueBadges: DueBadge[] = nodes.reduce<DueBadge[]>((acc, n) => {
    const due = dueDateFromRaw(n.extra?.dueDate);
    if (due !== null) {
      const rel = relativeDue(due, now);
      acc.push({
        memberId: n.memberId,
        rect: { x: n.x - box.minX, y: n.y - box.minY, w: n.w, h: n.h },
        label: rel.label,
        urgency: rel.urgency,
      });
    }
    return acc;
  }, []);

  // Resolve the board's surface look so the opened board reads like the original (the solid
  // backdrop colour — the dominant visual). Reuses the same catalog the live board uses (L093).
  const surface = backgroundById(board.background);

  return (
    <Container layout="vertical" gap="sm">
      <Text variant="body-md" weight="semibold">
        {board.title}
      </Text>
      <Container
        position="relative"
        style={{ width: box.w, height: box.h, ...(surface.color ? { background: surface.color } : {}), borderRadius: 8 }}
      >
        {nodes.map((n) => {
          const Renderer = rendererForKind(n.kind);
          return (
            <Container
              key={n.memberId}
              position="absolute"
              style={{ left: n.x - box.minX, top: n.y - box.minY, width: n.w, height: n.h }}
            >
              <Renderer item={n} selected={false} editing={false} />
            </Container>
          );
        })}
        {connectorModels.length > 0 ? (
          <ConnectorLayer connectors={connectorModels} rects={rects} preview={null} onSelect={NOOP} />
        ) : null}
        {metricPills.length > 0 ? <BoardMetricLayer pills={metricPills} onOpen={NOOP} /> : null}
        {dueBadges.length > 0 ? <BoardDueDateLayer badges={dueBadges} onOpen={NOOP} /> : null}
      </Container>
    </Container>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const NOOP = (): void => {};

export interface SharedCapsuleViewProps {
  readonly capsule: ShareCapsule;
  /** Wall-clock ms for relative-time (due-date) badges; injected so it stays deterministic in tests. */
  readonly now?: number;
}

/** Render a whole shared capsule (its name + every board it carries), read-only. */
export function SharedCapsuleView({ capsule, now = Date.now() }: SharedCapsuleViewProps): JSX.Element {
  return (
    <Container layout="vertical" gap="lg">
      <Text variant="heading-sm" weight="semibold">
        {capsule.name}
      </Text>
      {capsule.boards.map((board) => (
        <SharedBoard key={board.boardId} board={board} now={now} />
      ))}
    </Container>
  );
}
