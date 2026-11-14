# disclosure-heading

The one heading that folds a list: sidebar lists ("Work", "Tools") and groups of records in the Library ("Week of September 20, 2026") use this same row.

## Files

| File | Purpose |
|------|---------|
| `DisclosureHeading.tsx` | The heading: the whole row is one toggle (label, count chip, turning chevron), with the list's actions revealed at its end while pointed at, focused, or kept shown. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `DisclosureHeading` | `(props: DisclosureHeadingProps) => JSX` | Renders the row. |
| `DisclosureHeadingProps` | `{label, accessibleLabel?, open, onOpenChange, count?, chevron?: 'start' \| 'end', actions?, actionsShown?, onPointedChange?, depth?, wrap?, className?}` | `count` shows as the sidebar's neutral badge chip with thousands separators; `chevron` picks its side; `wrap(toggle)` lets a caller place the toggle inside a hover card trigger (the Library's group summary). |

## Appearance

`screen-look/show/disclosure-heading.css`: no box or border at rest, the whole row lights on hover, the chevron turns when folded, actions fade in at the end (`[data-revealed]`).

## Dependencies

**Depends on:** `../coss/ui/button`, `../badge/Badge`, `../icon` (NamedIcon).

**Depended on by:** `../../../sidebar/show/SidebarContent.tsx` (list headings). A copy of bitfield-packages `packages/ui/show/disclosure-heading`; its tests live there.

## References (anatomy only)

21st.dev 31385 Collapsible and 14029 Disclosure (whole-row trigger, turning chevron); Higgsfield asset library day headings (Mobbin https://mobbin.com/screens/0d41df30-eca5-48b2-8235-978e81fa827f).
