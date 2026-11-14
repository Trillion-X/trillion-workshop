# ui/show/timeseries-chart/

Pure browser-local timeseries chart paint.

| Path | Purpose |
|---|---|
| `InteractiveTimeseriesChart.tsx` | Render caller-provided OHLC buckets, optional summary stats, bucket selector, and chart-mode selector. |

Rules:

- No addressed reads.
- No Envelope invokes.
- No feature/package vocabulary.
- Callers own data source, bucket state, and what the metric means.
- Callers may hide mode and bucket controls when the chart is serving one obvious metric.
- Empty states must breathe; do not fill an empty chart with fake data.
- Finance usage favors larger plot space, subtle grid lines, and high-contrast price movement.
