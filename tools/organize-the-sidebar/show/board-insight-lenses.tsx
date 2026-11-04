// packages/group/show/board-insight-lenses.tsx
//
// The board's INSIGHT-LENS REGISTRY as a pure builder (b218-follow-on). This is the DATA the `InsightsMenu`
// (show/InsightsMenu.tsx) folds: an `InsightLens[]` describing every read-only board lens — its group, its
// availability gate, its label, and how to render its own anchored panel. Extracted out of the 8000-line
// `GroupBoardPanel` god file so the 16 availability GATES are unit-testable over varied board states (a single
// Chromium harness only exercises one board), and so the SAME registry can feed a second surface (e.g. the
// board Command Palette) without duplicating the gate logic (L069: one registry → N subscribers; SSOT).
//
// BLIND & GENERIC: this builder names no menu and no surface — it only turns a board context into lens DATA.
// Adding a lens is one row here; the menu/palette that consume it change ZERO code (L069/L090).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Container } from '../../ui';
import type { AddressRef, GroupGraph } from '../../ui/show/group/group-graph';
import { type BoardItem, patchItem } from '../read-data/group-board-model';
import type { InsightLens } from './InsightsMenu';

import { DueSoonPanel } from './DueSoonPanel';
import { AgendaPanel } from './AgendaPanel';
import { ForecastPanel } from './ForecastPanel';
import { ReviewPanel } from './ReviewPanel';
import { MetricProgressPanel } from './MetricProgressPanel';
import { TimeRankPanel } from './TimeRankPanel';
import { HabitStreakPanel } from './HabitStreakPanel';
import { ImportancePanel } from './ImportancePanel';
import { NumberedOutlinePanel } from './NumberedOutlinePanel';
import { CriticalPathPanel } from './CriticalPathPanel';
import { BalancePanel } from './BalancePanel';
import { BoardBalanceReadout } from './BoardBalanceReadout';
import { BoardSizeRhythmReadout } from './BoardSizeRhythmReadout';
import { BoardOutlineReadout } from './BoardOutlineReadout';
import { BoardTidinessReadout } from './BoardTidinessReadout';
import { TagAffinityReadout } from './TagAffinityReadout';
import { BoardHubsReadout } from './BoardHubsReadout';
import { BoardComponentsReadout } from './BoardComponentsReadout';
import { BoardCyclesReadout } from './BoardCyclesReadout';
import { BoardOrderReadout } from './BoardOrderReadout';
import { BoardBottlenecksReadout } from './BoardBottlenecksReadout';
import { ReadinessPanel } from './ReadinessPanel';
import { HealthPanel } from './HealthPanel';

import { dueRows, overdueCount } from '../do-work/board-due-date-actions';
import { boardAgenda } from '../read-data/board-agenda';
import { attentionRows } from '../do-work/board-attention-actions';
import { momentumRows } from '../do-work/board-momentum-actions';
import { finishLineRows } from '../do-work/board-finish-line-actions';
import { boardDigest } from '../do-work/board-digest-actions';
import { metricRows } from '../do-work/board-metric-actions';
import { timeRows } from '../do-work/board-time-log-actions';
import { streakRows } from '../do-work/board-habit-actions';
import { importanceRows, importanceSummary } from '../do-work/board-importance-actions';
import { balanceRows, type BalanceFacet } from '../do-work/board-balance-actions';
import { forecastRows, boardForecastSummary } from '../do-work/board-forecast-actions';
import { criticalPathOfGoal, criticalRoots, labelForGoal } from '../do-work/board-critical-path-actions';
import { boardReadiness } from '../do-work/board-readiness-actions';
import { boardHealth, healthSignalDetails } from '../read-data/board-health';
import { censusReducedTable, reducedTableIsEmpty, type LabeledFacet } from '../read-data/reduced-table';
import { ReducedTablePanel } from './ReducedTablePanel';
import { boardSummary, summaryStatRows } from '../read-data/board-summary';
import { SummaryPanel } from './SummaryPanel';
import { boardQuestions } from '../read-data/board-questions';
import { QuestionsPanel } from './QuestionsPanel';
import { themesReducedTable } from '../read-data/board-themes';
import { rollupSpecFromRaw } from '../do-work/board-rollup-actions';
import { boardHasOutline } from '../read-data/board-numbered-outline';
import { matchesFacets } from '../read-data/facet-filter';
import { BOARD_ITEM_FACETS, BOARD_FOCUS_FACETS } from './board-item-facets';
import { spreadOutOverlaps, BOARD_GRID } from '../do-work/batch-actions';
import { itemTags, mergeTags } from './item-tags';

/** A rectangle in board (world) coords — the shape `nodeRects` maps and `frameRects` accepts. */
type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** Everything the lens registry needs from the board shell. All state/refs/callbacks are INJECTED — the builder
 *  itself is pure (same context → same lens DATA), so the gates are testable without a live panel. */
export interface BoardInsightLensCtx {
  /** Content nodes (notes/cards), section frames excluded from most gates via `isSection`. */
  readonly nodeItems: readonly BoardItem[];
  /** All items INCLUDING connectors — `items.length > nodeItems.length` means the board has connectors. */
  readonly items: readonly BoardItem[];
  /** The "now" frame time (ms) that dates/forecasts resolve against. */
  readonly now: number;
  /** memberId → its world rect, for jump-to framing. */
  readonly nodeRects: ReadonlyMap<string, Rect>;
  /** Frame the viewport onto these rects. */
  readonly frameRects: (rects: readonly Rect[]) => void;
  /** A REF to the live selection (drives the Tag-map single-focus affordance). Passed as a ref — not the value —
   *  so the owner's registry memo need NOT rebuild (and recompute PageRank/forecast/critical-path) on every
   *  selection change; the Tag-map render reads `.current` at render time, so it still sees the live selection. */
  readonly selectedIdsRef: { readonly current: ReadonlySet<string> };
  readonly setSelectedIds: (next: ReadonlySet<string>) => void;
  /** Commit a new graph (used by the light write actions — tag-map onAddTag). */
  readonly commit: (after: GroupGraph) => unknown;
  readonly graphRef: { readonly current: GroupGraph };
  readonly currentRefRef: { readonly current: AddressRef };
  /** Run a selection-scoped batch mutation (used by Tidiness one-click spread-out). */
  readonly applyBatch: (produce: (graph: GroupGraph, memberIds: string[], parentRef: AddressRef) => GroupGraph) => void;
  /** Reorder a presentation frame (used by the Frames lens). */
  readonly reorderFrameById: (frameId: string, dir: -1 | 1) => void;
  /** The board's raw roll-up spec (for Review digest + Critical path gating). */
  readonly rollupSpecRaw: unknown;
}

/** Build the ordered `InsightLens[]` for a board. Availability gates + labels are computed from the context;
 *  each lens's `render` returns its own anchored panel and wires its jump/close/actions. The declared order +
 *  `group` tags drive the InsightsMenu sections (Deadlines / Momentum / Structure / Composition). */
export function boardInsightLenses(ctx: BoardInsightLensCtx): InsightLens[] {
  const { nodeItems, items, now, nodeRects, frameRects, selectedIdsRef, setSelectedIds, commit, graphRef, currentRefRef, applyBatch, reorderFrameById, rollupSpecRaw } = ctx;

  const labelOf = (id: string): string => nodeItems.find((it) => it.memberId === id)?.text?.trim() || id;
  const jumpTo = (onClose: () => void) => (memberId: string): void => {
    setSelectedIds(new Set([memberId]));
    const r = nodeRects.get(memberId);
    if (r) frameRects([r]);
    onClose();
  };
  // Every lens's panel shares the SAME anchored position; the helper keeps the descriptors to one line each.
  const panel = (node: JSX.Element): JSX.Element => (
    <Container position="absolute" style={{ right: 12, top: 56, zIndex: 62 }}>{node}</Container>
  );

  const dueRowsN = dueRows(nodeItems, now);
  const overdue = overdueCount(nodeItems, now);
  const agendaGroups = boardAgenda(nodeItems, now);
  const attention = attentionRows(nodeItems, now);
  const momentum = momentumRows(nodeItems, now);
  const finishLine = finishLineRows(nodeItems, now);
  const reviewTotal = attention.length + momentum.length + finishLine.length;
  const metric = metricRows(nodeItems);
  const time = timeRows(nodeItems, 'total');
  const streaks = streakRows(nodeItems, now);
  // Core ideas = PageRank importance over the connector graph — needs the FULL `items` (endorsement edges live
  // in the connectors). Feeding `nodeItems` (connectors stripped) leaves the graph edgeless → uniform ranks +
  // zero endorsers for every card → the lens could never surface. (Completes the finding-1/L063 category sweep:
  // importanceRows is the last graph engine; every other builder reader is per-card/facet and stays nodeItems.)
  const importance = importanceRows(items, labelOf);
  const balanceFacets: BalanceFacet[] = BOARD_FOCUS_FACETS.map((f) => ({ key: f.key, label: f.label, extract: BOARD_ITEM_FACETS[f.key] }));
  const balance = balanceRows(nodeItems, balanceFacets);
  // Breakdown = the interactive census of the reducer family: per facet dimension (Tag/Color/Type/Progress/
  // Deadline) with ≥2 values, every value + its card count, each a click-to-select control. Reuses the SAME
  // labeled facet catalog as Diversity (title = the facet label); the census/pivot/histogram share one shape.
  const breakdownFacets: LabeledFacet[] = balanceFacets.map((f) => ({ key: f.key, title: f.label, extract: f.extract }));
  const breakdown = censusReducedTable(nodeItems, breakdownFacets);
  // Overview = the board's vital signs (cards / words / % complete / orphans) as read-only stat rows — the
  // board-wide census nothing else surfaces in one glance (distinct from health's SCORE and breakdown's slices).
  const summary = boardSummary(items); // full items: boardSummary counts connectors + computes orphans (see above)
  const summaryRows = summaryStatRows(summary);
  // Questions + Themes: compute the analysis ONCE (both the availability gate and the render read this, so the
  // full O(cards) scan never runs twice on open — the compute-once SSOT pattern the other lenses use, b221/L030).
  const questions = boardQuestions(nodeItems);
  const themesTable = themesReducedTable(nodeItems);
  const forecast = forecastRows(nodeItems, now);
  const forecastSummary = boardForecastSummary(nodeItems, now);
  const critSpec = rollupSpecFromRaw(rollupSpecRaw);
  // Graph/connectivity engines (critical-path, readiness, health-orphans, summary-orphans) MUST see the FULL
  // `items` (connectors included) — they build the relation graph from the connector edges and filter content
  // cards internally. Feeding `nodeItems` (connectors stripped) blinds the graph: every card reads as an orphan
  // and no dependency is ever seen. (Codex convergence 2026-07-09 finding 1/L063 — `hubs` already used `items`.)
  const critRoots = critSpec ? criticalRoots(items, critSpec) : [];
  const critResult = critSpec && critRoots.length > 0 ? criticalPathOfGoal(items, critRoots[0], critSpec, now) : null;
  // Readiness = the dependency FRONTIER (what's actionable now vs blocked) over the 'depends-on' relation — the
  // SAME classify-readiness engine the "Select ready" bulk action uses. Only surfaced once something is BLOCKED,
  // so the ready-vs-blocked distinction is meaningful (a board with no dependencies makes everything "ready").
  const readiness = boardReadiness(items);
  // Board hygiene: the 0–100 health score + per-signal detail (with the flagged card ids, for jump-to-issue).
  // Only surfaced when a signal actually flags something (L118 — a perfect board needs no "improve" list).
  const health = boardHealth(items);
  const healthDetails = healthSignalDetails(items);

  return [
    { key: 'due', group: 'Deadlines', label: overdue > 0 ? `Due soon · ${overdue} overdue` : 'Due soon', available: dueRowsN.length > 0,
      render: (onClose) => panel(<DueSoonPanel rows={dueRowsN} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'agenda', group: 'Deadlines', label: 'Agenda', available: agendaGroups.length > 0,
      render: (onClose) => panel(<AgendaPanel groups={agendaGroups} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'forecast', group: 'Deadlines', label: forecastSummary.atRisk > 0 ? `Forecast · ${forecastSummary.atRisk} at risk` : 'Forecast', available: forecast.length > 0,
      render: (onClose) => panel(<ForecastPanel rows={forecast} summary={forecastSummary} now={now} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'review', group: 'Momentum', label: reviewTotal > 0 ? `Review · ${reviewTotal}` : 'Review', available: reviewTotal > 0,
      render: (onClose) => panel(<ReviewPanel attention={attention} momentum={momentum} finishLine={finishLine} digest={boardDigest(nodeItems, critSpec, now)} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'progress', group: 'Momentum', label: metric.length > 0 ? `Progress · ${metric.length}` : 'Progress', available: metric.length > 0,
      render: (onClose) => panel(<MetricProgressPanel rows={metric} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'time', group: 'Momentum', label: time.length > 0 ? `Time · ${time.length}` : 'Time', available: time.length > 0,
      render: (onClose) => panel(<TimeRankPanel rows={time} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'streaks', group: 'Momentum', label: streaks.length > 0 ? `Streaks · ${streaks.length}` : 'Streaks', available: streaks.length > 0,
      render: (onClose) => panel(<HabitStreakPanel rows={streaks} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'core', group: 'Structure', label: 'Core ideas', available: importance.some((r) => r.endorsers > 0),
      render: (onClose) => panel(<ImportancePanel rows={importance} summary={importanceSummary(importance)} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'outline', group: 'Structure', label: 'Outline', available: boardHasOutline(nodeItems),
      render: (onClose) => panel(<NumberedOutlinePanel items={nodeItems} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'critpath', group: 'Structure', label: 'Critical path', available: critResult !== null,
      render: (onClose) => panel(critResult !== null ? <CriticalPathPanel result={critResult} labelOf={labelForGoal(nodeItems)} onJumpTo={jumpTo(onClose)} onClose={onClose} /> : <></>) },
    { key: 'readiness', group: 'Structure', label: 'Ready to start', available: readiness.some((r) => r.status === 'blocked'),
      render: (onClose) => panel(<ReadinessPanel readiness={readiness} labelOf={labelForGoal(nodeItems)} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'questions', group: 'Structure', label: 'Open questions', available: questions.length > 0,
      render: (onClose) => panel(<QuestionsPanel cards={questions} onJumpTo={jumpTo(onClose)} onClose={onClose} />) },
    { key: 'diversity', group: 'Composition', label: 'Diversity', available: balance.length > 0,
      render: (onClose) => panel(<BalancePanel rows={balance} onClose={onClose} onSelectDominant={(row) => {
        const ids = nodeItems.filter((it) => matchesFacets(it, { [row.key]: [row.dominant] }, BOARD_ITEM_FACETS)).map((it) => it.memberId);
        setSelectedIds(new Set(ids));
        onClose();
      }} />) },
    { key: 'overview', group: 'Composition', label: 'Overview', available: summary.cards > 0 || summary.sections > 0,
      render: (onClose) => panel(<SummaryPanel rows={summaryRows} onClose={onClose} />) },
    { key: 'breakdown', group: 'Composition', label: 'Breakdown', available: !reducedTableIsEmpty(breakdown),
      render: (onClose) => panel(<ReducedTablePanel title="Breakdown" table={breakdown} onClose={onClose} onPickGroup={(g) => {
        setSelectedIds(new Set(g.cardIds));
        const rs = g.cardIds.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
        if (rs.length) frameRects(rs);
        onClose();
      }} />) },
    { key: 'themes', group: 'Composition', label: 'Themes', available: !reducedTableIsEmpty(themesTable),
      render: (onClose) => panel(<ReducedTablePanel title="Recurring themes" table={themesTable} onClose={onClose} onPickGroup={(g) => {
        setSelectedIds(new Set(g.cardIds));
        const rs = g.cardIds.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
        if (rs.length) frameRects(rs);
        onClose();
      }} />) },
    { key: 'composition', group: 'Composition', label: 'Balance', available: nodeItems.length > 0,
      render: (_onClose) => panel(
        <Container layout="vertical" gap="sm">
          <BoardBalanceReadout items={nodeItems.filter((i) => !i.isSection)} />
          <BoardSizeRhythmReadout items={nodeItems.filter((i) => !i.isSection)} />
        </Container>
      ) },
    { key: 'frames', group: 'Structure', label: 'Frames', available: nodeItems.length > 0,
      render: (onClose) => panel(
        <BoardOutlineReadout
          items={items}
          onPickSection={(memberIds) => {
            setSelectedIds(new Set(memberIds));
            const rs = memberIds.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
            if (rs.length) frameRects(rs);
          }}
          onPickCard={(memberId) => {
            setSelectedIds(new Set([memberId]));
            const r = nodeRects.get(memberId);
            if (r) frameRects([r]);
            onClose();
          }}
          onReorderSection={(frameId, dir) => reorderFrameById(frameId, dir)}
        />
      ) },
    { key: 'tidiness', group: 'Composition', label: 'Tidiness', available: nodeItems.length > 0,
      render: (onClose) => panel(
        <BoardTidinessReadout
          items={nodeItems.filter((i) => !i.isSection)}
          onPickIssue={(memberIds) => {
            setSelectedIds(new Set(memberIds));
            const rs = memberIds.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
            if (rs.length) frameRects(rs);
            onClose();
          }}
          onTidyUp={() => {
            const cardIds = nodeItems.filter((i) => !i.isSection).map((i) => i.memberId);
            applyBatch((g, _ids, p) => spreadOutOverlaps(g, p, cardIds, BOARD_GRID));
          }}
        />
      ) },
    { key: 'health', group: 'Composition', label: 'Board health', available: healthDetails.some((d) => d.applicable && d.affected.length > 0),
      render: (onClose) => panel(<HealthPanel health={health} details={healthDetails} onClose={onClose} onJumpIssue={(ids) => {
        setSelectedIds(new Set(ids));
        const rs = ids.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
        if (rs.length) frameRects(rs);
        onClose();
      }} />) },
    { key: 'tagmap', group: 'Composition', label: 'Tag map', available: nodeItems.length > 0,
      render: (onClose) => {
        // When exactly one card is focused, drive the "you might also tag" strip from its tags and let a
        // chip click WRITE the tag onto that card (the emergent second use of the co-occurrence lens).
        const sel = selectedIdsRef.current;
        const focusId = sel.size === 1 ? [...sel][0] : null;
        const focusCard = focusId ? nodeItems.find((i) => i.memberId === focusId && !i.isSection) : undefined;
        return panel(
          <TagAffinityReadout
            items={nodeItems}
            focusTags={focusCard ? itemTags(focusCard) : undefined}
            onAddTag={focusCard ? (tag) => {
              void commit(patchItem(graphRef.current, currentRefRef.current, focusCard.memberId, { tags: mergeTags(itemTags(focusCard), [tag]) }));
            } : undefined}
            onPickTag={(tag) => {
              const ids = nodeItems
                .filter((i) => itemTags(i).some((t) => t.trim().replace(/^[#@]+/, '').toLowerCase() === tag))
                .map((i) => i.memberId);
              if (ids.length) {
                setSelectedIds(new Set(ids));
                const rs = ids.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
                if (rs.length) frameRects(rs);
              }
              onClose();
            }}
          />
        );
      } },
    { key: 'hubs', group: 'Structure', label: 'Hubs', available: items.length > nodeItems.length,
      render: (onClose) => {
        // Multi-card picks (islands / cycles / waves) select + frame the whole set, then collapse.
        const pickMany = (memberIds: string[]): void => {
          setSelectedIds(new Set(memberIds));
          const rs = memberIds.map((id) => nodeRects.get(id)).filter((r): r is Rect => Boolean(r));
          if (rs.length) frameRects(rs);
          onClose();
        };
        return panel(
          <Container layout="vertical" gap="sm">
            <BoardHubsReadout items={items} onPickHub={jumpTo(onClose)} />
            {/* Islands: the separate connected clusters. Self-hides unless there is more than one. */}
            <BoardComponentsReadout items={items} onPickComponent={pickMany} />
            {/* Circular dependencies: rings that wait on each other. Self-hides unless a cycle exists. */}
            <BoardCyclesReadout items={items} onPickCycle={pickMany} />
            {/* Do-order: the dependency waves. Self-hides when there is no orderable structure. */}
            <BoardOrderReadout items={items} onPickWave={pickMany} />
            {/* Load-bearing cards: structural single points of failure. Self-hides with no cut vertex. */}
            <BoardBottlenecksReadout items={items} onPickBottleneck={jumpTo(onClose)} />
          </Container>
        );
      } },
  ];
}
