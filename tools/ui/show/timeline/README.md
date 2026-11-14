# timeline/

A vertical connected timeline — ordered steps on a connecting rail, each a glowing icon badge with a time label, title, and detail (Vibecode / Alan / Hers anatomy), driven entirely by DATA items.

## Files

| File | Purpose |
|------|---------|
| `Timeline.tsx` | The component + `TimelineItemView` type: paints resolved items as a vertical rail — each step an `IconTile` badge (with `glow`) or a plain dot, connected by a 1px rail, beside a time + title + detail. The last step draws no trailing rail. |
| `index.ts` | Barrel — exports `Timeline` and `TimelineItemView`. |
| `Timeline.test.tsx` | Tests: one row per item in order, the connecting rail count (N items → N-1 rails), badge vs dot, a different domain from items alone, empty. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `TimelineItemView` | `{ id: string; icon?: LucideIcon; tone?: IconTileTone; time?: string; title: string; detail?: string }` | One already-resolved step. `icon` absent → a plain dot marker (never a fabricated icon). |
| `Timeline` | `({ items: TimelineItemView[]; className? }) → JSX` | The timeline. Paints the items; knows no domain. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`, `@/packages/ui/show/icon-tile/IconTile` (the glowing badge), `@/packages/ui/show/text` (Text), `lucide-react` (type only).
**Depended on by:** timeline-oriented feature surfaces and the `ui` barrel (`packages/ui/index.ts`).

## Why This Design?

The sequence is DATA (L069/L090): a pre-match routine, a recovery protocol, a morning ritual, an onboarding checklist are all the SAME component, only the items differ — zero code per sequence. It reuses the shared `IconTile` (with its `glow` badge) rather than re-styling an icon chip, so the only bespoke element is the 1px connecting rail (legitimate primitive-level styling — this is the `ui` floor).
