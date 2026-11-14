# nesting-guide

The guide beside the rows of an open list: one soft pill down their side, thick enough to read, rounded at both ends, and inset so the next list's pill never touches it.

## Files

| File | Purpose |
|------|---------|
| `NestingGuide.tsx` | The guide's structure: one decorative `span.nesting-guide` with its level and whether it starts or ends here. |
| `index.ts` | Exports `NestingGuide` and `NestingGuideProps`. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `NestingGuide` | `({ level?: number = 0, start?: boolean = true, end?: boolean = true }) => JSX.Element` | One guide, or one segment of a guide drawn a row at a time. `start` and `end` round and inset its ends. |
| `NestingGuideProps` | `{ level?, start?, end? }` | Its props. |

## Usage

```tsx
// A list: one pill beside every row (the parent is positioned and sets --nesting-guide-left).
<Container data-nesting-guide-host="">{rows}<NestingGuide /></Container>

// A tree, a row at a time: one segment per level, a pill from the first row under a folder to the last row of its open subtree.
{row.guides.map((guide, level) => <NestingGuide key={level} level={level} start={guide.start} end={guide.end} />)}
```

## Invariants

- Structure only: width, colour, inset and radius come from `parts/screen-look/show/nesting-guide.css` (`--nesting-guide-width`, `--nesting-guide-color`, `--nesting-guide-inset`, `--nesting-guide-left`, `--nesting-guide-step`).
- Decorative: `aria-hidden`, no pointer input.

## Why This Design?

The owner (Apple Note, 2026-09-30): the line next to each open list was so thin it should be thicker, rounded like a pill, and one list's line ended so close to the next list's that they read as one line. A sidebar list and a file tree draw the same guide, so it is one part with one look.

## Dependencies

**Depends on:** `react` (types only); its look, `parts/screen-look/show/nesting-guide.css`.
**Depended on by:** `parts/sidebar/show/SidebarContent.tsx` (each open list), `parts/ui/show/coss/project-tree.tsx` (each open folder in a tree).
