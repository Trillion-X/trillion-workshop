# intent-prefetch

Starts what a pointer is heading for before it arrives: the pointer's last moments predict where it will be shortly, and the one target the path to that point crosses is started (code fetched, reads warmed) with an AbortSignal that is aborted when the path turns away. Each open reports how long ahead of it the start was made.

## Files

| File | Purpose |
|------|---------|
| `intent-prefetch.ts` | `watchIntent` (the watcher over a root), and its pure parts `predictedPoint`, `crosses`, `intendedTarget`, `intentOff`. |
| `intent-prefetch.json` | DATA: sample window, look-ahead, reach, least speed, when nothing is started ahead (save-data, slow connections, small devices), opens kept for timings. |
| `index.ts` | Exports. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `watchIntent` | `(root, { targets, keyOf, start, device?, now? }) => IntentWatcher` | Watches mouse and pen pointers over `root`; starts at most one target at a time with an abort signal. |
| `IntentWatcher` | `{ opened(key), timings(), off, stop() }` | `opened` keeps the time to open against the start made for that key; `timings` answers opens, how many were started ahead and the median lead; `off` says why nothing is started on this device. |
| `intendedTarget` | `(samples, targets) => key \| null` | The target under the pointer, else the only target the predicted path crosses; ambiguous paths start nothing. |

## Consumers

- `src/workspace/main.tsx`: the sidebar's screens. Heading for a screen row starts its code and the reads it waits on; a click reports the open.

## Invariants

1. Domain blind: targets, keys and what a start does belong to the consumer.
2. Mouse and pen only; one unambiguous target; one live start.
3. Nothing is started ahead on save-data, slow connections or small devices.
4. Boxes are read at most once per animation frame.
