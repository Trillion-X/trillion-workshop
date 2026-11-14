# IconTile

A Lucide icon — or a served image — centered inside a fixed-size, rounded, tinted surface square — the recurring "icon chip" used by hero blocks, status headers, and feature cards.

## Files

| File | Purpose |
| --- | --- |
| `IconTile.tsx` | The IconTile component + `iconTileVariants` CVA. |
| `IconTile.test.tsx` | Tests: icon + label render, plain tile casts no glow, `glow` casts ring + halo, glow tone maps colour, caller style merges with glow. |

## Key Types / Functions

| Type / Function | Shape | Role |
| --- | --- | --- |
| `IconTile` | `forwardRef<HTMLDivElement, IconTileProps>` | Icon centered in a rounded, tinted square. |
| `IconTileProps` | `{ icon?: LucideIcon, image?: string, tone?, size?, label?, glow? }` | `tone`: neutral/success/warning/error/info/accent. `size`: sm/md/lg. `glow` (opt-in): a soft tone-coloured halo + a defined hairline ring — the feature-card "glowing badge" lift, on-theme for dark monochrome surfaces where a faint tint fill alone reads as invisible. Plain tiles unchanged. `image`: a served image URL (`/cas/…`, `/byte-address/…`, remote) rendered in place of the glyph — same container, so glyph tiles and image tiles keep uniform depth; the art is data. |
| `iconTileVariants` | CVA | Size + tone → tile classes. |

## Why this design

Replaces the ad-hoc `<Container className="h-14 w-14 rounded-2xl bg-...">  <Icon/> </Container>` pattern that would otherwise leak inline styling into feature code (L065). Tone maps to a design-token background + matching icon color, so tiles stay consistent system-wide. The tile owns its size and tint; callers pass only the icon and a semantic tone.

## Dependencies

**Depends on:** `class-variance-authority`, `lucide-react`, `@/packages/ui/show/cn`, `@/packages/ui/show/icon` (`Icon`).
**Depended on by:** `@/packages/ui` barrel; `@/packages/ui/show/timeline/Timeline` (step badges, `glow`); any feature surface needing an icon chip.
