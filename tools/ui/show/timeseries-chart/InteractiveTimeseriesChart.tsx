import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AreaChart, BarChart3, TrendingUp } from 'lucide-react';

import { Button } from '../button';
import { Card } from '../card';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';

export interface TimeseriesChartBucket {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  accumulated: number;
  volume?: number;
}

export interface TimeseriesChartSummary {
  total: number;
  average: number;
  min: number;
  max: number;
  count: number;
}

export interface TimeseriesChartConfig {
  title?: string;
  metric: string;
  bucket?: string;
  chartMode?: 'candlestick' | 'line' | 'area';
  showModeControls?: boolean;
  showBucketControls?: boolean;
  showAccumulated?: boolean;
  showAverage?: boolean;
  showAccumulatedTooltip?: boolean;
  valuePrefix?: string;
  valueSuffix?: string;
  valueDecimals?: number;
  tooltipDescription?: string;
  eventLabel?: string;
  openLabel?: string;
  highLabel?: string;
  lowLabel?: string;
  closeLabel?: string;
  totalLabel?: string;
  averageLabel?: string;
  minLabel?: string;
  maxLabel?: string;
  countLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

export interface InteractiveTimeseriesChartProps {
  config: TimeseriesChartConfig;
  buckets: readonly TimeseriesChartBucket[];
  summary?: TimeseriesChartSummary | null;
  activeBucket: string;
  onActiveBucketChange: (bucket: string) => void;
}

const CHART_WIDTH = 800;
const CHART_HEIGHT = 430;
const PADDING = { top: 32, right: 28, bottom: 54, left: 70 };

const BUCKET_OPTIONS = [
  { value: '1m', label: '1 Min' },
  { value: '5m', label: '5 Min' },
  { value: '1h', label: '1 Hour' },
  { value: '1d', label: '1 Day' },
  { value: '1w', label: '1 Week' },
];

const MODE_OPTIONS = [
  { value: 'candlestick', label: 'Candle' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
] as const;

function formatValue(val: number, config: TimeseriesChartConfig): string {
  const decimals = typeof config.valueDecimals === 'number'
    ? config.valueDecimals
    : config.metric === 'cost'
      ? 2
      : 0;
  if (config.metric === 'tokens') {
    return val >= 1000000
      ? `${(val / 1000000).toFixed(1)}M`
      : val >= 1000
        ? `${(val / 1000).toFixed(1)}K`
        : String(Math.round(val));
  }
  const formatted = val.toFixed(Math.max(0, decimals));
  return `${config.valuePrefix ?? ''}${formatted}${config.valueSuffix ?? ''}`;
}

function formatTimestamp(ts: number, bucket: string): string {
  const d = new Date(ts);
  if (bucket === '1m' || bucket === '5m' || bucket === '1h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function bucketLabel(bucket: string): string {
  switch (bucket) {
    case '1m': return 'minute';
    case '5m': return '5 minutes';
    case '1h': return 'hour';
    case '1d': return 'day';
    case '1w': return 'week';
    default: return 'period';
  }
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="ghost" padding="none" layout="stack">
      <Text variant="caption" color="muted">{label}</Text>
      <Text variant="body" mono tabular>{value}</Text>
    </Card>
  );
}

export function InteractiveTimeseriesChart({
  config,
  buckets,
  summary,
  activeBucket,
  onActiveBucketChange,
}: InteractiveTimeseriesChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [chartMode, setChartMode] = useState<'candlestick' | 'line' | 'area'>(
    config.chartMode ?? 'candlestick',
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const showModeControls = config.showModeControls !== false;
  const showBucketControls = config.showBucketControls !== false;

  const chartMetrics = useMemo(() => {
    if (buckets.length === 0) {
      return {
        innerWidth: CHART_WIDTH - PADDING.left - PADDING.right,
        innerHeight: CHART_HEIGHT - PADDING.top - PADDING.bottom,
        maxValue: 1,
        minValue: 0,
        valueRange: 1,
        barWidth: 40,
        gap: 4,
        xScale: (_i: number) => PADDING.left,
        yScale: (_value: number) => PADDING.top,
        yTicks: [0.25, 0.5, 0.75, 1],
      };
    }

    const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
    const maxValue = Math.max(...buckets.map((b) => b.high), 1);
    const minValue = Math.min(...buckets.map((b) => b.low), 0);
    const valueRange = maxValue - minValue || 1;
    const barWidth = Math.max(4, Math.min(20, innerWidth / buckets.length - 2));
    const gap = (innerWidth - barWidth * buckets.length) / Math.max(1, buckets.length - 1);
    const xScale = (i: number) => PADDING.left + i * (barWidth + gap);
    const yScale = (value: number) =>
      PADDING.top + innerHeight * (1 - (value - minValue) / valueRange);
    const yTicks = Array.from({ length: 5 }, (_, i) => minValue + (valueRange * i) / 4);

    return { innerWidth, innerHeight, maxValue, minValue, valueRange, barWidth, gap, xScale, yScale, yTicks };
  }, [buckets]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || buckets.length === 0) return;

      const rect = svgRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const svgX = (x / rect.width) * CHART_WIDTH;
      let nearestIndex = 0;
      let minDistance = Infinity;
      for (let index = 0; index < buckets.length; index += 1) {
        const bucketX = chartMetrics.xScale(index) + chartMetrics.barWidth / 2;
        const distance = Math.abs(svgX - bucketX);
        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = index;
        }
      }
      setHoveredIndex(nearestIndex);
    },
    [buckets, chartMetrics],
  );

  if (buckets.length === 0) {
    return (
      <Card variant="nested" padding="lg" layout="stack" className="min-h-[320px] justify-center rounded-2xl">
        <Text variant="heading-xl" as="h3">
          {config.emptyTitle ?? config.title ?? 'No data'}
        </Text>
        <Text variant="body" color="muted">
          {config.emptyDescription ?? 'No data is available for this chart yet.'}
        </Text>
      </Card>
    );
  }

  return (
    <Card variant="nested" padding="lg" layout="stack" className="rounded-2xl">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Text variant="heading" as="h3">
          {config.title ?? 'Time Series'}
        </Text>

        {(showModeControls || showBucketControls) && (
          <Container layout="horizontal" gap="sm" alignItems="center">
            {showModeControls && (
              <Container layout="horizontal" gap="xs" alignItems="center">
                {MODE_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant="ghost"
                    size="icon"
                    onClick={() => setChartMode(option.value)}
                    active={chartMode === option.value}
                    title={option.label}
                  >
                    <Icon
                      icon={option.value === 'candlestick' ? BarChart3 : option.value === 'line' ? TrendingUp : AreaChart}
                      size="sm"
                    />
                  </Button>
                ))}
              </Container>
            )}

            {showBucketControls && (
              <Container layout="horizontal" gap="xs" alignItems="center">
                {BUCKET_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant="ghost"
                    size="sm"
                    onClick={() => onActiveBucketChange(option.value)}
                    active={activeBucket === option.value}
                  >
                    {option.label}
                  </Button>
                ))}
              </Container>
            )}
          </Container>
        )}
      </Container>

      <Container
        gap="none"
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: `${CHART_WIDTH} / ${CHART_HEIGHT}`,
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: '100%', display: 'block' }}
          role="img"
          aria-label={`${config.metric} time series chart`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {chartMetrics.yTicks.map((tick) => (
            <line
              key={`grid-${tick}`}
              x1={PADDING.left}
              y1={chartMetrics.yScale(tick)}
              x2={CHART_WIDTH - PADDING.right}
              y2={chartMetrics.yScale(tick)}
              stroke="var(--border-primary)"
              strokeDasharray="3 5"
              strokeWidth={0.5}
              opacity={0.55}
            />
          ))}

          {chartMetrics.yTicks.map((tick) => (
            <text
              key={`ytick-${tick}`}
              x={PADDING.left - 8}
              y={chartMetrics.yScale(tick) + 4}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize={11}
              opacity={0.75}
            >
              {formatValue(tick, config)}
            </text>
          ))}

          {buckets.map((bucket, index) =>
            index % Math.max(1, Math.floor(buckets.length / 8)) === 0 ? (
              <text
                key={`xtick-${index}`}
                x={chartMetrics.xScale(index) + chartMetrics.barWidth / 2}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fill="var(--text-muted)"
                fontSize={11}
                opacity={0.75}
              >
                {formatTimestamp(bucket.timestamp, activeBucket)}
              </text>
            ) : null,
          )}

          {chartMode === 'candlestick' &&
            buckets.map((bucket, index) => {
              const isUp = bucket.close >= bucket.open;
              const color = isUp ? 'var(--color-success)' : 'var(--color-error)';
              const bodyTop = chartMetrics.yScale(Math.max(bucket.open, bucket.close));
              const bodyBottom = chartMetrics.yScale(Math.min(bucket.open, bucket.close));
              const bodyHeight = Math.max(1, bodyBottom - bodyTop);
              return (
                <g key={`candle-${index}`}>
                  <line
                    x1={chartMetrics.xScale(index) + chartMetrics.barWidth / 2}
                    y1={chartMetrics.yScale(bucket.high)}
                    x2={chartMetrics.xScale(index) + chartMetrics.barWidth / 2}
                    y2={chartMetrics.yScale(bucket.low)}
                    stroke={color}
                    strokeWidth={1}
                  />
                  <rect
                    x={chartMetrics.xScale(index)}
                    y={bodyTop}
                    width={chartMetrics.barWidth}
                    height={bodyHeight}
                    fill={color}
                    fillOpacity={0.8}
                    rx={1}
                  />
                </g>
              );
            })}

          {chartMode === 'line' && (
            <polyline
              points={buckets
                .map((bucket, index) => `${chartMetrics.xScale(index) + chartMetrics.barWidth / 2},${chartMetrics.yScale(bucket.close)}`)
                .join(' ')}
              fill="none"
              stroke="var(--text-primary)"
              strokeWidth={2.2}
            />
          )}

          {chartMode === 'area' && (
            <polygon
              points={[
                ...buckets.map((bucket, index) => `${chartMetrics.xScale(index) + chartMetrics.barWidth / 2},${chartMetrics.yScale(bucket.close)}`),
                `${chartMetrics.xScale(buckets.length - 1) + chartMetrics.barWidth / 2},${chartMetrics.yScale(chartMetrics.minValue)}`,
                `${chartMetrics.xScale(0) + chartMetrics.barWidth / 2},${chartMetrics.yScale(chartMetrics.minValue)}`,
              ].join(' ')}
              fill="var(--text-primary)"
              fillOpacity={0.08}
              stroke="var(--text-primary)"
              strokeWidth={2}
            />
          )}

          {config.showAccumulated && (() => {
            const maxAccumulated = Math.max(...buckets.map((bucket) => bucket.accumulated), 1);
            return (
              <polyline
                points={buckets
                  .map((bucket, index) => {
                    const accScale = chartMetrics.yScale(
                      chartMetrics.minValue + (bucket.accumulated / maxAccumulated) * chartMetrics.valueRange,
                    );
                    return `${chartMetrics.xScale(index) + chartMetrics.barWidth / 2},${accScale}`;
                  })
                  .join(' ')}
                fill="none"
                stroke="var(--text-primary)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                strokeOpacity={0.6}
              />
            );
          })()}

          {config.showAverage && (() => {
            let sum = 0;
            return (
              <polyline
                points={buckets
                  .map((bucket, index) => {
                    sum += bucket.close;
                    const avg = sum / (index + 1);
                    return `${chartMetrics.xScale(index) + chartMetrics.barWidth / 2},${chartMetrics.yScale(avg)}`;
                  })
                  .join(' ')}
                fill="none"
                stroke="var(--accent-blue)"
                strokeWidth={1.5}
                strokeOpacity={0.7}
              />
            );
          })()}

          {hoveredIndex !== null && hoveredIndex < buckets.length && (() => {
            const bucket = buckets[hoveredIndex];
            const cx = chartMetrics.xScale(hoveredIndex) + chartMetrics.barWidth / 2;
            const cy = chartMetrics.yScale(bucket.close);
            return (
              <g>
                <line
                  x1={cx}
                  y1={PADDING.top}
                  x2={cx}
                  y2={CHART_HEIGHT - PADDING.bottom}
                  stroke="var(--text-tertiary)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <line
                  x1={PADDING.left}
                  y1={cy}
                  x2={CHART_WIDTH - PADDING.right}
                  y2={cy}
                  stroke="var(--text-tertiary)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <circle cx={cx} cy={cy} r={4} fill="var(--text-primary)" />
              </g>
            );
          })()}
        </svg>

        {hoveredIndex !== null && hoveredIndex < buckets.length && (() => {
          const bucket = buckets[hoveredIndex];
          const cx = chartMetrics.xScale(hoveredIndex) + chartMetrics.barWidth / 2;
          const cy = chartMetrics.yScale(bucket.close);
          const tooltipWidth = 200;
          const tooltipHeight = 160;
          const svgRect = svgRef.current?.getBoundingClientRect();
          if (!svgRect) return null;
          const scaleX = svgRect.width / CHART_WIDTH;
          const scaleY = svgRect.height / CHART_HEIGHT;
          let screenX = svgRect.left + (cx + 10) * scaleX;
          const screenY = svgRect.top + cy * scaleY - tooltipHeight / 2;
          if (screenX + tooltipWidth > svgRect.right) {
            screenX = svgRect.left + (cx - 10) * scaleX - tooltipWidth;
          }

          return createPortal(
            <Card
              variant="popover"
              padding="sm"
              layout="stack"
              style={{
                position: 'fixed',
                left: `${screenX}px`,
                top: `${screenY}px`,
                minWidth: `${tooltipWidth}px`,
                pointerEvents: 'none',
                zIndex: 50,
              }}
            >
              <Text as="div" variant="body-xs" weight="semibold" color="default">
                {formatTimestamp(bucket.timestamp, activeBucket)}
              </Text>
              <Text as="div" variant="caption" color="muted">
                {config.tooltipDescription ?? `Values for this ${bucketLabel(activeBucket)}`}
              </Text>
              <Container layout="vertical" gap="xs">
                <Container layout="horizontal" gap="xs" justifyContent="between">
                  <Text as="span" variant="body-xs" color="muted">{config.openLabel ?? 'Open'}:</Text>
                  <Text as="span" variant="body-xs" color="default" mono tabular>{formatValue(bucket.open, config)}</Text>
                </Container>
                <Container layout="horizontal" gap="xs" justifyContent="between">
                  <Text as="span" variant="body-xs" color="muted">{config.highLabel ?? 'High'}:</Text>
                  <Text as="span" variant="body-xs" color="default" mono tabular>{formatValue(bucket.high, config)}</Text>
                </Container>
                <Container layout="horizontal" gap="xs" justifyContent="between">
                  <Text as="span" variant="body-xs" color="muted">{config.lowLabel ?? 'Low'}:</Text>
                  <Text as="span" variant="body-xs" color="default" mono tabular>{formatValue(bucket.low, config)}</Text>
                </Container>
                <Container layout="horizontal" gap="xs" justifyContent="between">
                  <Text as="span" variant="body-xs" color="muted">{config.closeLabel ?? 'Close'}:</Text>
                  <Text as="span" variant="body-xs" color="default" mono tabular>{formatValue(bucket.close, config)}</Text>
                </Container>
              </Container>
              <Container layout="horizontal" gap="sm" justifyContent="between">
                <Text as="span" variant="body-xs" color="muted">
                  {bucket.volume ?? 0} {config.eventLabel ?? 'events'}
                </Text>
                {config.showAccumulatedTooltip !== false && (
                  <Text as="span" variant="body-xs" color="muted">
                    {config.totalLabel ?? 'Total'}: {formatValue(bucket.accumulated ?? 0, config)}
                  </Text>
                )}
              </Container>
            </Card>,
            document.body,
          );
        })()}
      </Container>

      {summary && (
        <Card variant="ghost" padding="sm" layout="row">
          <StatItem label={config.totalLabel ?? 'Total'} value={formatValue(summary.total, config)} />
          <StatItem label={config.averageLabel ?? 'Average'} value={formatValue(summary.average, config)} />
          <StatItem label={config.minLabel ?? 'Min'} value={formatValue(summary.min, config)} />
          <StatItem label={config.maxLabel ?? 'Max'} value={formatValue(summary.max, config)} />
          <StatItem label={config.countLabel ?? 'Events'} value={String(summary.count)} />
        </Card>
      )}
    </Card>
  );
}
