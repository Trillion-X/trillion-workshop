# use-mark

One small mark on a picture's corner saying how far a piece of work has gone (in an edit, exported, scheduled) or, once it reached somewhere, the destinations' own logos; hovering shows one sentence per relationship.

## Files

| File | Purpose |
| --- | --- |
| `UseMark.tsx` | The mark: stage glyph or up to two destination logos plus a count, inside the shared Tooltip with its lines. |
| `use-mark-content.tsx` | `useMarkContent(options)`: the mark with this package's provider-icon registry rows filled in, for callers outside React. |
| `index.ts` | Public exports. |

## Key Types / Functions

| Name | Signature / Shape | Role |
| --- | --- | --- |
| `UseMark` | `({label, tone?, icon?, destinations?, lines?, registry}) => JSX` | Draws the mark. Words, tone and glyph are DATA from the caller. |
| `UseMarkDestination` | `{label: string; providerSlug?: string}` | One place the work went; the slug picks the logo. |
| `useMarkContent` | `(options: Omit<UseMarkProps,'registry'>) => JSX` | Same mark with the registry supplied. |

Appearance: `packages/screen-look/show/use-mark.css` (`use-mark*` classes, tone ring by `data-tone`).

## Dependencies

**Depends on:** `../tooltip`, `../icon/NamedIcon`, `../provider-mark/ProviderMark`, `../../things-to-store-and-run.json` (provider-icon rows).

**Depended on by:** media-workspace Library `used` field (`media-workspace.js`, through `window.ExpansionControls.useMarkContent`).

## Invariants

- Knows no stage, platform or product; a caller with nothing to say mounts nothing.
- At most two logos; more become `+n`.

References: Apple Photos grid marks (https://mobbin.com/screens/d55c8518-c10c-4dc4-a83b-5da9531f741b); Hero UI Badge anatomy on 21st.dev (id 13824), inspiration only.
