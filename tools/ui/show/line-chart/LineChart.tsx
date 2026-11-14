//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Thin single-weight line chart with a subtle gradient area fill — the quiet
// trend line used by financial cockpits (reference anatomy: fey.com stock
// detail performance line). This is the OPPOSITE of a bar Sparkline: one
// continuous hairline stroke that traces the series, with a faint top-to-bottom
// gradient washing the area beneath it.
//
// It is a pure, generic, data-driven primitive: hand it a numeric series and a
// tone, it renders a responsive SVG that fills its container width. Any package
// that needs a quiet price/equity/metric trend reuses THIS — never a one-off
// inline SVG (L069: one primitive, N subscribers).
//
// TWO USAGE TIERS, ONE PRIMITIVE:
//   - Glyph tier (account spark, order spark): pass `points` + `tone` + a small
//     `height`. No axis, no range row — pure trend shape.
//   - Hero tier (fey market chart): additionally pass `showAxis` (minimal
//     price/time labels), `formatValue`, and a plain-text `ranges` row
//     (1D 1W 1M 3M YTD 1Y All) with `activeRange` + `onRangeChange`. The active
//     range renders bright, the rest dim — plain text, NEVER chunky pills.
// The hero features are all OPTIONAL and additive, so the glyph callers are
// untouched: this stays the single canonical line chart (no second source).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE COMPONENT: no data reads, no durable state, no calculations beyond
//    geometry. The caller owns the series and the tone.
// 2. RESPONSIVE: a viewBox + preserveAspectRatio="none" means the line fills
//    whatever width/height the container gives it. The caller sets the height
//    via the `height` variant; width follows the parent.
// 3. SINGLE WEIGHT: the stroke is one hairline (vector-effect non-scaling-stroke
//    so it stays crisp at any width). NEVER chunky, NEVER a barcode.
// 4. TONE = SEMANTIC: success (up / green), error (down / red), neutral. The
//    stroke and the gradient fill both follow the tone — they reference the same
//    --color-* / --text-* tokens the rest of the system uses.
// 5. DEGRADES HONESTLY: fewer than two points renders an honest empty state
//    (premium copy or a soft shimmer when `loading`), never a fabricated curve.
// 6. THE RANGE ROW IS PLAIN TEXT: active = --text-primary, inactive = muted that
//    lifts on hover. No border, no fill, no pill — the fey timeframe behavior.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { GLASS_POPOVER_BG_CLASS } from '../glass-tokens';

// ---------------------------------------------------------------------------
// VARIANTS — height presets only; width is always the full container.
// ---------------------------------------------------------------------------

export const lineChartVariants = cva('block w-full', {
  variants: {
    height: {
      xs: 'h-10',
      sm: 'h-16',
      md: 'h-28',
      lg: 'h-44',
      xl: 'h-60',
    },
  },
  defaultVariants: {
    height: 'md',
  },
});

export type LineChartTone = 'success' | 'error' | 'neutral';

/** A single point on the line. Bare numbers are accepted for the glyph tier;
 *  the `{ value, t }` form carries an epoch-ms timestamp used only to render
 *  the optional x-axis time labels. */
export type LineChartPoint = number | { value: number; t?: number };

/** A selectable timeframe in the plain-text range row. */
export interface LineChartRange {
  id: string;
  label: string;
}

export interface LineChartProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'points'>,
    VariantProps<typeof lineChartVariants> {
  /** The series, oldest → newest. Fewer than 2 points = honest empty state. */
  points: readonly LineChartPoint[];
  /** Semantic tone: up (success), down (error), or neutral. Drives stroke + fill.
   *  Omit to derive tone from the first → last delta. */
  tone?: LineChartTone;
  /** Render the faint gradient area fill beneath the line (default true). */
  fill?: boolean;
  /** Hairline stroke width in viewBox units (default 1.5 — fey single-weight). */
  strokeWidth?: number;
  /** Show minimal price (left) + time (bottom) axis labels — the hero tier. */
  showAxis?: boolean;
  /** Formats axis price labels + the hover readout. Default: String(value). */
  formatValue?: (value: number) => string;
  /** Plain-text timeframe row (hero tier). Omit for a pure glyph. */
  ranges?: readonly LineChartRange[];
  /** Active range id (bright); the rest render dim. */
  activeRange?: string;
  onRangeChange?: (id: string) => void;
  /** Honest empty-state copy when there are < 2 points. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Render the empty body as a soft shimmer (loading) instead of static copy. */
  loading?: boolean;
}

// The internal coordinate space. preserveAspectRatio="none" stretches this to
// the container, and non-scaling-stroke keeps the line crisp regardless.
const VIEW_W = 600;
const VIEW_H = 200;
// Vertical breathing room so the peak/trough never touch the frame edge.
const PAD_Y = 8;

// The canonical color tokens (defined in global-source.css). The Tailwind
// utilities (.text-status-success …) read these same --color-* vars, so the
// stroke matches the rest of the system exactly.
const STROKE_TOKEN: Record<LineChartTone, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-error)',
  neutral: 'var(--text-subtle)',
};

function pointValue(point: LineChartPoint): number {
  return typeof point === 'number' ? point : point.value;
}

function pointTime(point: LineChartPoint): number | undefined {
  return typeof point === 'number' ? undefined : point.t;
}

function deriveTone(points: readonly LineChartPoint[]): LineChartTone {
  if (points.length < 2) return 'neutral';
  const first = pointValue(points[0]);
  const last = pointValue(points[points.length - 1]);
  if (last > first) return 'success';
  if (last < first) return 'error';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// RANGE ROW (plain text — active bright, inactive dim; never a pill)
// ---------------------------------------------------------------------------

function RangeRow({
  ranges,
  active,
  onSelect,
}: {
  ranges: readonly LineChartRange[];
  active?: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <div role="tablist" aria-label="Timeframe" className="flex flex-row items-center gap-5">
      {ranges.map((range) => {
        const selected = range.id === active;
        return (
          <button
            key={range.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect?.(range.id)}
            className={cn(
              'cursor-pointer border-0 bg-transparent p-0 text-xs font-medium tabular-nums transition-colors focus:outline-none',
              selected
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Thin single-weight trend line with a subtle gradient area fill.
 *
 * @example Glyph tier
 * ```tsx
 * <LineChart points={[101.2, 101.8, 100.9, 102.4]} tone="success" height="sm" />
 * ```
 * @example Hero tier (fey market chart)
 * ```tsx
 * <LineChart
 *   points={bars.map((b) => ({ value: b.close, t: b.timestamp }))}
 *   height="xl"
 *   showAxis
 *   formatValue={(v) => `$${v.toFixed(2)}`}
 *   ranges={[{ id: '1D', label: '1D' }, { id: '1W', label: '1W' }]}
 *   activeRange="1D"
 *   onRangeChange={setRange}
 * />
 * ```
 */
export const LineChart = React.forwardRef<SVGSVGElement, LineChartProps>(
  (
    {
      className,
      height,
      points,
      tone,
      fill = true,
      strokeWidth = 1.5,
      showAxis = false,
      formatValue,
      ranges,
      activeRange,
      onRangeChange,
      emptyTitle = 'No price data',
      emptyDescription = 'A price line appears here once data is available.',
      loading = false,
      ...props
    },
    ref,
  ) => {
    // Stable gradient id per instance so multiple charts on one screen don't
    // collide on the same <defs> id.
    const gradientId = React.useId();
    const resolvedTone = tone ?? deriveTone(points);
    const stroke = STROKE_TOKEN[resolvedTone];
    const fmt = formatValue ?? ((v: number) => `${v}`);

    const [hover, setHover] = React.useState<number | null>(null);
    const svgRef = React.useRef<SVGSVGElement>(null);
    const setSvgRef = React.useCallback(
      (node: SVGSVGElement | null) => {
        svgRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<SVGSVGElement | null>).current = node;
      },
      [ref],
    );

    const geometry = React.useMemo(() => {
      if (points.length < 2) return null;
      let min = Infinity;
      let max = -Infinity;
      for (const point of points) {
        const value = pointValue(point);
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      const span = max - min || 1; // flat series → a centered flat line, no divide-by-zero
      const stepX = VIEW_W / (points.length - 1);
      const usableH = VIEW_H - PAD_Y * 2;
      const coords = points.map((point, index) => {
        const raw = pointValue(point);
        const safe = Number.isFinite(raw) ? raw : min;
        const x = index * stepX;
        // Invert Y: SVG origin is top-left, but a higher value sits higher.
        const y = PAD_Y + (1 - (safe - min) / span) * usableH;
        return { x, y };
      });
      const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
      return { line, area, min, max, coords };
    }, [points]);

    const onMove = React.useCallback(
      (event: React.MouseEvent<SVGSVGElement>) => {
        if (!geometry || !svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * VIEW_W;
        let nearest = 0;
        let best = Infinity;
        for (let i = 0; i < geometry.coords.length; i += 1) {
          const d = Math.abs(svgX - geometry.coords[i].x);
          if (d < best) { best = d; nearest = i; }
        }
        setHover(nearest);
      },
      [geometry],
    );

    // The optional plain-text timeframe row sits beneath the plot.
    const rangeRow = ranges && ranges.length > 0 ? (
      <div className="flex flex-row items-center pt-3">
        <RangeRow ranges={ranges} active={activeRange} onSelect={onRangeChange} />
      </div>
    ) : null;

    // Minimal axis labels (hero tier) — a few price ticks on the left, a few
    // time ticks along the bottom. Rendered as crisp DOM text overlaid on the
    // stretched plot (immune to preserveAspectRatio="none").
    const axisOverlay = geometry && showAxis ? (() => {
      const yLabels = [geometry.max, (geometry.max + geometry.min) / 2, geometry.min];
      const count = Math.min(5, points.length);
      const xIdx = Array.from({ length: count }, (_, i) =>
        Math.round((i * (points.length - 1)) / Math.max(1, count - 1)),
      );
      return (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between py-1">
            {yLabels.map((tick, i) => (
              <span key={`yl-${i}`} className="text-[length:var(--font-size-caption)] tabular-nums text-[var(--text-muted)]">
                {fmt(tick)}
              </span>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 -bottom-4 flex flex-row justify-between">
            {xIdx.map((idx, i) => {
              const t = pointTime(points[idx]);
              const label = t
                ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
              return (
                <span key={`xl-${i}`} className="text-[length:var(--font-size-caption)] tabular-nums text-[var(--text-muted)]">
                  {label}
                </span>
              );
            })}
          </div>
        </>
      );
    })() : null;

    const hovered = geometry && hover !== null && hover < points.length ? points[hover] : null;

    return (
      <div className="flex w-full flex-col">
        <div className={cn('relative w-full', showAxis ? 'pb-4' : '')}>
          <svg
            ref={setSvgRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            className={cn(lineChartVariants({ height }), className)}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            {...props}
          >
            {geometry ? (
              <>
                {fill ? (
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stroke} stopOpacity="0.20" />
                      <stop offset="55%" stopColor={stroke} stopOpacity="0.05" />
                      <stop offset="100%" stopColor={stroke} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                ) : null}
                {fill ? <path d={geometry.area} fill={`url(#${gradientId})`} stroke="none" /> : null}
                <path
                  d={geometry.line}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                {hover !== null && hover < geometry.coords.length ? (
                  <g>
                    <line
                      x1={geometry.coords[hover].x}
                      y1={0}
                      x2={geometry.coords[hover].x}
                      y2={VIEW_H}
                      stroke="var(--text-muted)"
                      strokeWidth={0.75}
                      strokeDasharray="3 4"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={geometry.coords[hover].x}
                      cy={geometry.coords[hover].y}
                      r={3}
                      fill={stroke}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ) : null}
              </>
            ) : null}
          </svg>

          {/* Honest empty / loading body — calm centered copy or a soft shimmer
              band, never a fabricated curve. Overlaid so it fills the height. */}
          {!geometry ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
              {loading ? (
                <div className="h-px w-3/4 animate-pulse rounded-full bg-[var(--border-primary)]" aria-hidden="true" />
              ) : (
                <>
                  <span className="text-sm font-medium text-[var(--text-secondary)]">{emptyTitle}</span>
                  <span className="text-xs text-[var(--text-muted)]">{emptyDescription}</span>
                </>
              )}
            </div>
          ) : null}

          {axisOverlay}

          {/* Hover readout — a quiet price chip pinned to the top-right. */}
          {hovered ? (
            <div className={cn('pointer-events-none absolute right-0 top-0 rounded-md px-2 py-1', GLASS_POPOVER_BG_CLASS)}>
              <span className="text-[length:var(--font-size-caption)] font-semibold tabular-nums text-[var(--text-primary)]">
                {fmt(pointValue(hovered))}
              </span>
            </div>
          ) : null}
        </div>
        {rangeRow}
      </div>
    );
  },
);

LineChart.displayName = 'LineChart';
