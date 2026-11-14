# container-size

One shared mechanism for surfaces to adapt to the width of the container they are placed in, not the window.

## Why

A pane that is 300px wide inside a 1600px window is a phone-sized surface. Viewport media queries (`@media`, Tailwind `sm:`) cannot see that, so every surface used to need its own resize code. The industry answer is CSS container queries (Baseline since 2025): a layout owner declares a size container and components query it. This folder is the one place that vocabulary lives.

## How it works

1. **CSS half.** A layout owner wraps hosted content in `ContainerSizeRegion` (or applies `SURFACE_CONTAINER_STYLE`). That element becomes the named container `surface`. Any stylesheet inside, including inside a shadow root, writes:
   ```css
   @container surface (max-width: 600px) { .my-toolbar { flex-wrap: wrap; } }
   ```
2. **JS half.** For structural changes CSS cannot make, `bindContainerSize(element, {onChange})` keeps `data-container-size` (`compact` / `medium` / `wide` by default) current and reports class changes only.

`screen-arrangement` wraps every pane body in `ContainerSizeRegion`, so every surface opened in a pane is inside a `surface` container with no per-surface wiring. Shared components (record views, calendar grid) query that container, so every app using them adapts too.

## Files

| File | Purpose |
|------|---------|
| `container-size.ts` | Size-class DATA, `containerSizeClass`, `bindContainerSize`, the `surface` container name and style |
| `ContainerSizeRegion.tsx` | React wrapper that is the named container and carries `data-container-size` |
| `index.ts` | Public exports |
| `container-size.test.ts` | Class selection, caller DATA classes, attribute writing, unmeasured elements |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ContainerSizeClass` | `{id: string; below_px?: number}` | One ordered size-class row; last row open-ended |
| `DEFAULT_CONTAINER_SIZE_CLASSES` | `compact <600`, `medium <900`, `wide` | Default rows |
| `containerSizeClass` | `(width, classes?) => string` | Class for a width |
| `bindContainerSize` | `(element, {classes?, onChange?}) => dispose` | Measures, writes `data-container-size`, reports changes |
| `SURFACE_CONTAINER_NAME` / `SURFACE_CONTAINER_STYLE` | `'surface'` / `{containerType, containerName}` | Named container declaration |
| `ContainerSizeRegion` | `(props: div props & {classes?})` | Wrapper for layout owners |

## Dependencies

**Depends on:** React (region only), `ResizeObserver`.
**Depended on by:** `screen-arrangement` `SplitTreeArranger` pane bodies; `ui/show/twenty/record-table.css` (record views bar); `ui/show/calendar-grid` picker density; Expansion (`media-workspace`) Schedule calendar through `window.ExpansionControls.bindContainerSize`.
