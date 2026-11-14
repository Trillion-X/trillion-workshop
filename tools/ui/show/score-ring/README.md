# score-ring/

A tone-graded circular gauge with a big centered reading — the hero anatomy of every readiness/recovery/state readout (WHOOP recovery, Oura readiness, Visible stability, a flow/mood score).

## Files

| File | Purpose |
|------|---------|
| `ScoreRing.tsx` | The ring component + `ScoreRingProps`/`ScoreRingTone`. Pure presentational — the caller derives `tone` and every string from DATA; the ring names no domain and hardcodes no scale meaning. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `ScoreRingTone` | `'positive' \| 'caution' \| 'critical' \| 'neutral'` | The arc + band-pill color grade. The caller picks it from DATA thresholds. |
| `ScoreRingProps` | `{ value, max?, tone?, displayValue?, unit?, label?, band?, caption?, size?, thickness?, 'aria-label'? }` | `value/max` fill the arc; `label` sits above; `band` is the short tone-graded verdict pill under the ring (Whoop/Oura/Indeed/Visitors "number → band → detail" anatomy — the glanceable answer); `caption` is the prose one-liner below. `band`/`caption` absent → not rendered. |
| `ScoreRing(props)` | `(ScoreRingProps) → JSX` | Renders label → conic-gradient arc (only inline style is the sweep angle) → centered value/unit → `band` Badge → `caption`. |

## Dependencies

**Depends on:** `@/packages/ui/show/container` (`Container`), `@/packages/ui/show/text` (`Text`), `@/packages/ui/show/badge` (`Badge` — the tone-graded verdict pill).
**Depended on by:** visual-database metric-card compositions and the `ui` barrel.

## Why This Design?

The tone is a prop, not an internal threshold — a flow score, a recovery %, an NPS gauge are all the same ring from DATA (L069/L090). The `band` pill and the arc share one `tone` so the verdict and the ring read as a single signal; the pill is the instant-glance answer ("Locked in" / "Needs a reset") for a -1000IQ do-nothing user, shown before the caption prose. Tokens only — the graded arc rides `--status-*`/`--accent-purple`, never literal hex.
