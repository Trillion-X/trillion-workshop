// parts/ui/show/intent-prefetch/intent-prefetch.ts
//
// Purpose
//   One shared way to start what a pointer is heading for before it gets there: a row about to be opened, a place about
//   to be navigated to. The pointer's recent movement predicts where it will be a moment from now; the one target the
//   path to that point crosses is started (its code fetched, its reads warmed) with an AbortSignal, and the signal is
//   aborted when the path turns away. Each open says how long ahead of it the start was made (time to open).
//
// Non-negotiable invariants
//   1. Domain blind: the consumer names its targets (`targets()`), each target's key (`keyOf`) and what starting one does
//      (`start(key, { signal })`); nothing here knows a row, a screen or a read.
//   2. Mouse and pen only (touch has no path before the tap). Only an unambiguous target is started: the one under the
//      pointer, else the only one the predicted path crosses; several crossed starts none.
//   3. At most one start is live: a new target aborts the previous one, and leaving the root aborts it.
//   4. Nothing is started ahead when the browser asks to save data, on a slow connection or a small device
//      (intent-prefetch.json); the watcher then answers the reason and starts nothing.
//   5. Box reads happen at most once per animation frame, never per pointer event.

import settings from './intent-prefetch.json' with { type: 'json' }

export type IntentTarget = { key: string; box: { left: number; top: number; right: number; bottom: number } }
export type IntentWatcher = {
  /** Say a target was opened: its time to open is kept against the start made for it, if any. */
  opened: (key: string) => void
  /** What the opens kept so far say: how many opened after a start, and how long ahead of the open the start was. */
  timings: () => { opened: number; started_ahead: number; median_ahead_ms: number | null }
  /** Why nothing is started ahead on this device, or null. */
  off: string | null
  stop: () => void
}
type Sample = { x: number; y: number; at: number }
type Navigatorish = { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number }

/** Why this device starts nothing ahead (invariant 4), or null. */
export function intentOff(device: Navigatorish | undefined): string | null {
  if (device?.connection?.saveData) return 'save-data'
  if (device?.connection?.effectiveType && settings.slow_connections.includes(device.connection.effectiveType)) return 'slow-connection'
  if (typeof device?.deviceMemory === 'number' && device.deviceMemory < settings.least_device_memory_gb) return 'small-device'
  return null
}

/** Where the pointer will be `lookahead_ms` from now, from its samples (oldest first), at most `most_reach_px` away. */
export function predictedPoint(samples: readonly Sample[]): { x: number; y: number; speed: number } | null {
  if (!samples.length) return null
  const last = samples[samples.length - 1]
  const first = samples[0]
  const elapsed = last.at - first.at
  if (elapsed <= 0) return { x: last.x, y: last.y, speed: 0 }
  const vx = (last.x - first.x) / elapsed, vy = (last.y - first.y) / elapsed
  const speed = Math.hypot(vx, vy)
  const reach = Math.min(speed * settings.lookahead_ms, settings.most_reach_px)
  return speed ? { x: last.x + (vx / speed) * reach, y: last.y + (vy / speed) * reach, speed } : { x: last.x, y: last.y, speed: 0 }
}

/** Whether the segment from `a` to `b` crosses the box (Liang-Barsky clipping). */
export function crosses(a: { x: number; y: number }, b: { x: number; y: number }, box: IntentTarget['box']): boolean {
  let low = 0, high = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - box.left], [dx, box.right - a.x], [-dy, a.y - box.top], [dy, box.bottom - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > high) return false; if (t > low) low = t }
    else { if (t < low) return false; if (t < high) high = t }
  }
  return low <= high
}

const inside = (point: { x: number; y: number }, box: IntentTarget['box']) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom

/** The one target to start for these samples (invariant 2), or null. */
export function intendedTarget(samples: readonly Sample[], targets: readonly IntentTarget[]): string | null {
  const last = samples[samples.length - 1]
  if (!last) return null
  const under = targets.find(target => inside(last, target.box))
  if (under) return under.key
  const ahead = predictedPoint(samples)
  if (!ahead || ahead.speed < settings.least_speed_px_per_ms) return null
  const crossed = targets.filter(target => crosses(last, ahead, target.box))
  return crossed.length === 1 ? crossed[0].key : null
}

/** Watch pointers over `root` and start the target each is heading for (invariants 1-5). */
export function watchIntent(root: HTMLElement, { targets, keyOf, start, device = typeof navigator === 'undefined' ? undefined : navigator as Navigatorish, now = () => performance.now() }: {
  targets: () => Iterable<Element>
  keyOf: (element: Element) => string | null
  start: (key: string, options: { signal: AbortSignal }) => void
  device?: Navigatorish
  now?: () => number
}): IntentWatcher {
  const startedAt = new Map<string, number>()
  const kept: Array<number | null> = []
  const timings = () => {
    const ahead = kept.filter((lead): lead is number => lead !== null).sort((a, b) => a - b)
    return { opened: kept.length, started_ahead: ahead.length, median_ahead_ms: ahead.length ? ahead[Math.floor(ahead.length / 2)] : null }
  }
  const opened = (key: string) => {
    const at = startedAt.get(key)
    kept.push(at === undefined ? null : Math.max(0, now() - at))
    if (kept.length > settings.timings_kept) kept.shift()
  }
  const off = intentOff(device)
  if (off) return { opened, timings, off, stop: () => {} }
  let samples: Sample[] = []
  let live: { key: string; controller: AbortController } | null = null
  let frame: number | null = null
  const abort = () => { live?.controller.abort(); live = null }
  const decide = () => {
    frame = null
    const boxes: IntentTarget[] = []
    for (const element of targets()) {
      const key = keyOf(element)
      if (key) { const rect = element.getBoundingClientRect(); boxes.push({ key, box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }) }
    }
    const key = intendedTarget(samples, boxes)
    if (key === null || key === live?.key) return
    abort()
    const controller = new AbortController()
    live = { key, controller }
    startedAt.set(key, now())
    start(key, { signal: controller.signal })
  }
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    const at = now()
    samples.push({ x: event.clientX, y: event.clientY, at })
    samples = samples.filter(sample => at - sample.at <= settings.sample_ms)
    if (frame === null) frame = requestAnimationFrame(decide)
  }
  const leave = () => { samples = []; abort() }
  root.addEventListener('pointermove', move)
  root.addEventListener('pointerleave', leave)
  return {
    opened, timings, off: null,
    stop: () => {
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', leave)
      if (frame !== null) cancelAnimationFrame(frame)
      abort()
    },
  }
}
