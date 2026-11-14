// packages/ui/show/glass-tokens.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// SSOT for the glass popover surface class. Portalled surfaces (toasts, popovers,
// pickers, HUDs, tooltips rendered outside the themed subtree) may mount where
// `--glass-bg-popover` is undefined; an unguarded var() then resolves to
// TRANSPARENT and content bleeds through. The guarded fallback below is the ONE
// place that failure mode is handled — never inline the fallback literal again.
//
// A defined token can fail the same way: a look whose --glass-bg-popover equals its
// page colour draws a popover that reads as having no background (Trillion's own
// looks did until 2026-10-01). That case is caught per look by
// test/floating-surfaces-stand-apart.test.mjs; tooltips wear the look's ink instead
// (Card variant `tooltip`).
//
// NON-NEGOTIABLE INVARIANT: every ui primitive that paints a popover-glass
// background composes this constant (or GLASS_POPOVER_FALLBACK for non-bg uses)
// instead of writing its own `var(--glass-bg-popover, ...)` expression.
// =============================================================================

/** Concrete fallback when --glass-bg-popover is not defined (portal contexts). */
export const GLASS_POPOVER_FALLBACK = 'rgba(18,18,20,0.92)';

/** Tailwind class painting the guarded glass popover background. */
export const GLASS_POPOVER_BG_CLASS = 'bg-[var(--glass-bg-popover,rgba(18,18,20,0.92))]';
