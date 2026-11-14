# Container

Generic layout component replacing raw `<div>` and `className` in feature code (L065 compliance).

## Purpose

Provides flexbox/grid layout with spacing, overflow, and flex sizing — all configured through props, not className. Enables zero-inline-styling architecture where ui/ components are the sole interface between feature code and Tailwind.

## Variants

### Layout
- `horizontal` — flex-row
- `vertical` — flex-col
- `grid` — grid layout
- `responsive-split` — flex-col, flex-row from `sm` up
- `flow` — plain block flow: text and inline pieces run on a line as words do. An editable's words use it, because text inside a flex container is split into separate items and a caret cannot rest in whitespace between them

### Spacing
- `gap` — xs/sm/md/lg/xl
- `padding` — xs/sm/md/lg/xl/none

### Overflow
- `visible`
- `hidden`
- `auto`
- `y-auto` — vertical scroll
- `x-auto` — horizontal scroll

Scrollable variants automatically use the shared `scroll-fade` measurement and screen-look mask. `auto` checks all four edges; `x-auto` checks left/right; `y-auto` checks top/bottom. Fades appear only where more content remains and are removed for keyboard focus, reduced transparency, and forced-colour modes.

### Sizing
- `flex` — 1 or none (flex: 1 for flex-1)
- `flex="1"` — accepted compatibility alias and normalized to `flex={1}`
- `height` — full or auto
- `width` — full or auto
- `gridCols={number}` — arbitrary numeric grid columns expressed through the
  generated `gridTemplateColumns` style
- `indent` — 0 to 4: how far a row sits in under the row above it, one step a level (a tree drawn a row at a time,
  such as the places a share can go)

### Border
- `border` — none/bottom/right/top/all, or `quote`: a rule down the start edge with room beside it, for words set off
  as a quotation (a share's selected words)

### Alignment
- `alignItems` — start/center/end/stretch
- `justifyContent` — start/center/end/between/stretch

## Usage

```tsx
import { Container } from '@/packages/ui';

// Horizontal flex with gap and padding
<Container layout="horizontal" gap="md" padding="lg" alignItems="center">
  <Text>Left item</Text>
  <Text>Right item</Text>
</Container>

// Scrollable vertical list
<Container
  layout="vertical"
  gap="sm"
  overflow="y-auto"
  flex={1}
  height="full"
>
  {items.map((item) => <Item key={item.id} {...item} />)}
</Container>

// Grid layout with centered content
<Container layout="grid" gap="md" alignItems="center" justifyContent="center">
  {/* grid children */}
</Container>
```

## Implementation

Renders the requested element with containerVariants CVA classes. Supports ref forwarding for scroll event handlers, onClick, etc. Numeric grid column counts and grid column spans are generated from props as DOM style values; callers still do not hand-write layout style objects.

## L065 Compliance

- Uses Card as base element (not raw `<div>`)
- All spacing/layout via CVA variants, not className
- Props-based configuration only
- No caller-authored inline layout styles; numeric grid props are translated by this component
- Supports ref for DOM access (scroll, measurement, etc.)

## Related

- Card (base container with styling options)
- Text, Icon, Badge (styled text/icon content components)
