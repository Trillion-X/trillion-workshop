# Pricing Overlay

The plans side by side, as a dialog in front of the app or as compact cards where a dialog does not fit.

## Files

| File | Purpose |
|------|---------|
| `PricingOverlay.tsx` | `PricingOverlay`: the plans dialog, a `StepOverlay` holding the plan cards, a loading or error line, and the comparison table when more than one plan has lines. `PlanCards`: the plan cards on their own (`compact` for a narrow place). |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `PricingOverlay` | `({ title, description, offers, loading?, busy?, error?, onChoose(id), onClose }) => JSX.Element` | The dialog; closing is always offered ("Close pricing"). |
| `PlanCards` | `({ offers, busy?, onChoose(id), compact?, lineLimit? }) => JSX.Element` | The cards; compact shows only the lines that differ between plans. |
| `PricingOverlayOffer` | `{ id, name, price, recommended, priced, lines, notes, action? }` | One plan as the cards draw it (built by `src/plan-cards.mjs`). |

## Dependencies

**Depends on:** `step-overlay` (the dialog itself), `comparison-table`, `sketch` (`PlanCard`).

**Depended on by:** the Trillion workspace's plan step for shared spaces (`src/workspace/spaces-plan-gate.tsx`) and the browser extension's plan offer (`extension/src/plan-offer.tsx`).
