# breathing-pacer/

A guided breathing pacer — a soft circle that grows, holds, and shrinks while the phase instruction swaps in time (Calm / Headspace / Breathwrk anatomy), driven entirely by DATA phases.

## Files

| File | Purpose |
|------|---------|
| `BreathingPacer.tsx` | The component: paints a decoded cycle (track ring + radial-gradient orb + stacked centered phase labels) and owns its keyframes in one `<style>`; motion off under `prefers-reduced-motion`. |
| `decode-breathing-cycle.ts` | Pure decoder: a raw phase list `[{label, seconds, scale?}]` → a `BreathingCycleView` with the exact per-cycle CSS `@keyframes` (core scale + one time-synced opacity window per label), seamless loop, deterministic animation names, fail-closed on junk. |
| `index.ts` | Barrel — exports `BreathingPacer`, `decodeBreathingCycle`, and the types. |
| `BreathingPacer.test.tsx` | Component tests: every phase renders, title/caption, keyframes injected once, a different pattern from DATA alone, empty fail-closed. |
| `decode-breathing-cycle.test.ts` | Decoder tests: total, forward-filled scale, seamless-loop start scale, boundary %s, a 4-7-8 pattern from DATA, deterministic names, seamless label swap, junk. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `RawBreathingPhase` | `{ label: string; seconds: number; scale?: number }` | One phase; `scale` = the size the circle REACHES at the phase end (omit = hold previous). |
| `BreathingCycleView` | `{ totalSeconds, coreAnimationName, coreKeyframesCss, keyframesCss, labels: BreathingLabelView[], phases: ResolvedBreathingPhase[], startScale, minScale, maxScale }` | The decoded, ready-to-paint cycle. |
| `decodeBreathingCycle` | `(raw, opts?: { idSeed?: string }) → BreathingCycleView` | Turns raw phases into the CSS keyframes + label windows. Pure. |
| `BreathingPacer` | `({ phases?, cycle?, idSeed?, size?, title?, caption?, className? }) → JSX` | The pacer. Pass raw `phases` (common) or a pre-decoded `cycle`. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn` (class merge), `lucide-react` (type only).
**Depended on by:** `ProtocolSession` pacer steps and the `ui` barrel (`packages/ui/index.ts`).

## Why This Design?

The breathing PATTERN is DATA (L069/L090): box breathing (4-4-4-4), 4-7-8, coherence (5-5), the physiological sigh are all the SAME component, only the phase list differs — zero code per pattern. The decoder computes exact keyframes so the animation is fully declarative (no JS timer), and each pacer's animation names are seeded so two on one screen never collide.
