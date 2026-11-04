// packages/group/do-work/label-color.ts
//
// DETERMINISTIC LABEL COLOR — the generative primitive behind "every tag/label gets its own stable, distinct
// colour, everywhere, forever". Unlike `branchColorAssignments` (which hands out palette[i] by branch ORDER,
// so the same label can get different colours on different boards) this is CONTENT-derived: `labelColor` hashes
// the label text to a hue, so #gardening is the SAME colour on every note, every board, every session — order-
// and palette-index-independent. It never runs out of colours (continuous hue, not a fixed N-slot palette) and
// needs zero registry: a new label colours itself. The bg/fg pair is contrast-safe by construction (a light
// pastel bg at fixed L, a dark same-hue ink at fixed L → always legible, no per-colour luminance branch, L069).
//
// Pure leaf: zero I/O, zero DOM, deterministic (a string hash — no Date/random). Case- and prefix-insensitive
// (`#Garden`, `@garden`, `garden` → one colour) so the SAME concept reads as one colour however it's written.

export interface LabelColor {
  readonly hue: number; // 0..359
  readonly bg: string; // light pastel chip background
  readonly fg: string; // dark same-hue ink (WCAG-legible on bg by construction)
  readonly key: string; // the normalised label the colour was derived from
}

// Fixed lightness pair: a very light bg and a dark ink of the SAME hue → high contrast for ANY hue, so no
// per-colour legibility check is ever needed (the pair is the structural elimination of the contrast problem).
const BG_S = 68;
const BG_L = 90;
const FG_S = 72;
const FG_L = 30;

/** Strip a leading #/@ and case so the same concept written any way maps to one colour. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/^[#@]+/, '').toLowerCase();
}

/** FNV-1a — a fast, deterministic, well-distributed 32-bit string hash (no random, stable across runs). */
function hashLabel(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The stable colour for a label: same text → same hue → same {bg,fg}, anywhere. */
export function labelColor(label: string): LabelColor {
  const key = normalizeLabel(label);
  const hue = hashLabel(key) % 360;
  return { hue, bg: `hsl(${hue}, ${BG_S}%, ${BG_L}%)`, fg: `hsl(${hue}, ${FG_S}%, ${FG_L}%)`, key };
}
