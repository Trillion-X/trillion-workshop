# name-and-create

A name field and the one action that creates or saves something under that name, side by side across the full width. Enter in the field runs the action. It sits in place beside the work, never in a dialog.

## Files

| File | Purpose |
|------|---------|
| `NameAndCreate.tsx` | The field (shared `Input`) and its action (shared `Button`), laid out by the shared `Container`. |
| `index.ts` | Barrel export. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `NameAndCreate` | `(props: NameAndCreateProps) => ReactElement` | Renders the field and its action. |
| `NameAndCreateProps` | `{label, value, onChange, onSubmit, actionLabel, disabled}` | `label` is the placeholder and the accessible name; Enter calls `onSubmit` only when not `disabled`. |

## Used by

- `parts/screen-arrangement/show/EmptyContainer.tsx`: "Name a folder / Create folder" when a person has no folders.
- `parts/screen-arrangement/show/LayoutPicker.tsx`: "Name this layout / Save layout" when the arrangement on screen is not yet one of the person's layouts.

## Design source

- The Mac original is `bitfield-packages/packages/screen-arrangement/show/EmptyContainer.tsx` (`NameAndCreate`) and the "Name current layout" row of `SavedLayoutMenu.tsx`; this is that row lifted into the shared parts.
- Mobbin, naming something to save it: v0 Save Design System (https://mobbin.com/screens/28c3de93-70f0-4bb4-8be2-ddfdda85384f), Supabase Save snippet (https://mobbin.com/screens/0d3001cd-3db6-4582-bd6c-341657b57761). Both ask in a dialog; this keeps the same one field and one action inline, since Trillion has no blocking dialogs.
- 21st.dev search "inline name input with save button" had no fit (autosave inputs and animated save buttons); the code composes the shared `Input` and `Button`.

## Dependencies

**Depends on:** `../button`, `../container`, `../input`.

**Depended on by:** `parts/screen-arrangement/show/EmptyContainer.tsx`, `parts/screen-arrangement/show/LayoutPicker.tsx`.
