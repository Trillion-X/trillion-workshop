# phone-sheet

On a phone (a finger and a small screen) every menu, popover and select opens as a sheet at the bottom edge: it slides up, runs the full width, has a grip on top, and a swipe down closes it.

## Files

| File | Purpose |
|------|---------|
| `phone-sheet.tsx` | `usePhoneSheet()` (the media answer), the attributes a sheet's positioner and surface carry, and `PhoneSheetGrip` (the grip and its swipe-down-to-close gesture). |
| `phone-sheet.json` | DATA: the widths and heights that count as a phone, and how far or fast a swipe down closes a sheet. |

## Key types / functions

| Name | Shape | Role |
|------|-------|------|
| `usePhoneSheet` | `() => boolean` | True while `PHONE_SHEET_QUERY` matches: `(pointer: coarse)` and narrower than `max_width_px` or shorter than `max_height_px`. A narrow desktop window (a mouse) answers false. |
| `PHONE_SHEET_QUERY` | `string` | The media query, built from `phone-sheet.json`. |
| `phoneSheetPositioner` | `(sheet: boolean) => Record<string, string>` | `data-phone-sheet` for the positioner; the stylesheet pins it to the bottom edge. |
| `phoneSheetSurface` | `(sheet: boolean) => Record<string, string>` | `data-phone-sheet-surface` for the element drawing the sheet (corners, fill, grip room, home-indicator room). |
| `PhoneSheetGrip` | `() => ReactElement` | The grip. Dragging it moves the sheet (`--phone-sheet-drag`); far (`close_distance_px` or `close_fraction` of the sheet) or fast (`close_speed_px_per_ms`) closes it through the primitive's own Escape handling. |
| `PHONE_SHEET_ATTRIBUTE`, `PHONE_SHEET_SURFACE_ATTRIBUTE` | `string` | The attribute names, for the stylesheet and checks. |

## Dependencies

**Depends on:** `../use-media-query` (the live media answer); the look in `parts/screen-look/show/floating-menus.css`.

**Depended on by:** `../coss/ui/menu.tsx` (MenuPopup, MenuSubPopup), `../coss/ui/popover.tsx` (PopoverPopup, except a tooltip-sized note), `../coss/ui/select.tsx` (SelectPopup), so ActionMenu, every Dropdown and every popover in Trillion; `scripts/narrow-widths.json` (the phone-sheet scene checks it).

## Why this design

The menu, popover or select stays the same primitive (its roles, typeahead, arrow keys, focus return and closing rules); only its placement changes on a phone. Swapping them into a dialog drawer would have dropped those. Anatomy after Amie on Mobbin (d055271a, d00daa2e); drag to dismiss after the 21st.dev coss.com and wensity drawers.
