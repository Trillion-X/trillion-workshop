// packages/group/do-work/board-tidiness.ts
//
// BOARD TIDINESS — the generative primitive behind "how messy is this board, and WHAT exactly is untidy"
// (the diagnostic COUNTERPART of the board's fixers `resolveOverlaps`/`spreadOutOverlaps`/align — they MOVE
// cards to fix a mess; this one MEASURES the mess and names each issue so a caller can select it, jump to it,
// or offer the one-click fix). The requests "flag overlapping cards / find the almost-aligned pairs / give me
// a tidiness score" are all ONE analysis configured by WHICH checks run: a set of injected DETECTORS, each a
// pure `(rects) → Issue[]`, dispatched through a DATA registry. Adding a check (uneven spacing, off-grid, tiny
// gaps, …) is one detector row, zero aggregate code (L069/L090).
//
// Pure leaf — only the `finiteCoord` clamp SSOT. Deterministic, zero I/O. The show/ readout renders the score
// + issue list and wires "select these" to the board; this file never knows what a "board" is.

import { finiteCoord } from '../read-data/finite-coord';

export interface TidyRect {
  readonly memberId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One self-describing tidiness issue — DATA the readout renders + acts on blindly. */
export interface TidyIssue {
  /** The detector kind (e.g. 'overlap', 'near-align'). */
  readonly kind: string;
  /** The member ids this issue concerns (a caller can select/jump to them). */
  readonly memberIds: readonly string[];
  /** 0..1 — how bad (1 = worst). Drives the score + sort order. */
  readonly severity: number;
  /** Human hint (e.g. which edge nearly aligns). */
  readonly detail?: string;
}

export type TidyDetector = (rects: readonly TidyRect[]) => TidyIssue[];

const fx = (v: number) => finiteCoord(v);
const areaOf = (r: TidyRect) => Math.max(0, fx(r.w)) * Math.max(0, fx(r.h));
const overlap1d = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Every pair of cards whose footprints OVERLAP — severity = the fraction of the SMALLER card covered (so a
 * card fully buried under another is severity 1). Sorted worst-first. The diagnostic behind "you have N
 * overlapping cards" + the input to a one-click `spreadOutOverlaps`.
 */
export function detectOverlaps(rects: readonly TidyRect[], opts: { minArea?: number } = {}): TidyIssue[] {
  const minArea = Math.max(0, opts.minArea ?? 1);
  const out: TidyIssue[] = [];
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    const ax = fx(a.x);
    const ay = fx(a.y);
    const aw = Math.max(0, fx(a.w));
    const ah = Math.max(0, fx(a.h));
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      const bx = fx(b.x);
      const by = fx(b.y);
      const bw = Math.max(0, fx(b.w));
      const bh = Math.max(0, fx(b.h));
      const ov = overlap1d(ax, ax + aw, bx, bx + bw) * overlap1d(ay, ay + ah, by, by + bh);
      if (ov <= minArea) continue;
      const smaller = Math.min(areaOf(a), areaOf(b));
      const severity = smaller > 0 ? Math.min(1, ov / smaller) : 1;
      out.push({ kind: 'overlap', memberIds: [a.memberId, b.memberId], severity, detail: 'cards overlap' });
    }
  }
  return out.sort((p, q) => q.severity - p.severity);
}

const EDGES: readonly { id: string; of: (r: TidyRect) => number }[] = [
  { id: 'left', of: (r) => fx(r.x) },
  { id: 'right', of: (r) => fx(r.x) + Math.max(0, fx(r.w)) },
  { id: 'top', of: (r) => fx(r.y) },
  { id: 'bottom', of: (r) => fx(r.y) + Math.max(0, fx(r.h)) },
  { id: 'centre-x', of: (r) => fx(r.x) + Math.max(0, fx(r.w)) / 2 },
  { id: 'centre-y', of: (r) => fx(r.y) + Math.max(0, fx(r.h)) / 2 },
];

/**
 * Pairs of cards whose matching edges (left/right/top/bottom/centre) are ALMOST — but not exactly — aligned
 * (0 < gap ≤ `tol`): a snap opportunity that reads as sloppy. Reports the STRONGEST near-miss per pair (max
 * severity = 1 − gap/tol), so a nearly-aligned pair yields one issue, not six. Exactly-aligned pairs (gap 0)
 * are tidy → not reported. The input to a one-click align.
 */
export function detectNearAlignment(rects: readonly TidyRect[], opts: { tol?: number } = {}): TidyIssue[] {
  const tol = Math.max(0.5, opts.tol ?? 6);
  const out: TidyIssue[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      let best = 0;
      let bestEdge = '';
      for (const e of EDGES) {
        const d = Math.abs(e.of(rects[i]) - e.of(rects[j]));
        if (d > 0 && d <= tol) {
          const sev = 1 - d / tol;
          if (sev > best) { best = sev; bestEdge = e.id; }
        }
      }
      if (best > 0) out.push({ kind: 'near-align', memberIds: [rects[i].memberId, rects[j].memberId], severity: best, detail: `${bestEdge} edges nearly align` });
    }
  }
  return out.sort((p, q) => q.severity - p.severity);
}

/** One tidiness check — DATA (the detector is injected; the aggregate never enumerates checks). `weight`
 *  scales how much this check's issues hurt the score. */
export interface TidyDetectorDef {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly detect: TidyDetector;
}

export const TIDINESS_DETECTORS: readonly TidyDetectorDef[] = [
  { id: 'overlap', label: 'Overlapping cards', weight: 1, detect: (r) => detectOverlaps(r) },
  { id: 'near-align', label: 'Nearly-aligned cards', weight: 0.35, detect: (r) => detectNearAlignment(r) },
];

export interface TidinessReport {
  /** All issues, worst-first (weighted). */
  readonly issues: (TidyIssue & { readonly detectorId: string })[];
  /** 0..1 tidiness (1 = spotless). */
  readonly score: number;
  /** Issue count per detector id. */
  readonly countsByKind: Readonly<Record<string, number>>;
}

/**
 * Run every detector over the rects → a {@link TidinessReport}. The score is `1 − min(1, Σ(weight·severity) /
 * N)`, so a clean board scores 1 and a pile of severe overlaps trends to 0; it's bounded and monotone (more/
 * worse issues → lower). Deterministic (issues sorted by weighted severity, then member ids). Empty/1 card → a
 * perfect score with no issues.
 */
export function analyzeTidiness(
  rects: readonly TidyRect[],
  detectors: readonly TidyDetectorDef[] = TIDINESS_DETECTORS,
): TidinessReport {
  const issues: (TidyIssue & { detectorId: string; _w: number })[] = [];
  const countsByKind: Record<string, number> = {};
  let penalty = 0;
  for (const det of detectors) {
    const found = det.detect(rects);
    countsByKind[det.id] = found.length;
    for (const iss of found) {
      issues.push({ ...iss, detectorId: det.id, _w: det.weight });
      penalty += det.weight * iss.severity;
    }
  }
  const score = Math.max(0, 1 - Math.min(1, penalty / Math.max(1, rects.length)));
  issues.sort(
    (a, b) =>
      b._w * b.severity - a._w * a.severity ||
      (a.memberIds[0] < b.memberIds[0] ? -1 : a.memberIds[0] > b.memberIds[0] ? 1 : 0),
  );
  return { issues: issues.map(({ _w, ...rest }) => rest), score, countsByKind };
}
