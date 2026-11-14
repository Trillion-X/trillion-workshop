# ColorDot Component

## Purpose

Renders a small colored circle indicator, either with an arbitrary hex/CSS color value (legends, charts, where colors come from data) or with a palette `tone` id that screen-look paints per look (a colour a person chose, such as a space's colour in its menu).

## Usage

```tsx
import { ColorDot } from '@/packages/ui';

<ColorDot color="#10b981" label="Read tool" size="sm" />
<ColorDot color="#3b82f6" size="md" />
<ColorDot tone="green" label="Green" />
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | string | one of `color` or `tone` | Hex or CSS color value (e.g., `#10b981`, `rgb(255,0,0)`) |
| `tone` | string | one of `color` or `tone` | A palette id (e.g., a space colour from `src/space-settings.json` colours); the dot carries `data-colour` and class `colour-dot`, and screen-look (`coss-workspace.css`) paints it in the current look, with no inline style |
| `size` | 'xs' \| 'sm' \| 'md' \| 'lg' | 'sm' | Dot size |
| `label` | string | - | Accessible label for screen readers |
| `className` | string | - | Additional CSS classes (merged with CVA) |

## L065 Exception

With `color`, this component uses inline `style={{ backgroundColor: color }}` because the color is **data-driven** (from caller records, chart data, or API responses), not hardcoded styling. This is a justified exception to L065: the style is bound to data, not design decisions.

## Sizes

- `xs`: 1.5 × 1.5 px
- `sm`: 2 × 2 px (default)
- `md`: 2.5 × 2.5 px
- `lg`: 3 × 3 px

## Examples

### Legend

```tsx
import { ColorDot, Container, Text } from '@/packages/ui';

<Container layout="horizontal" gap="md" alignItems="center">
  <Text>Tools:</Text>
  {items.map((item) => (
    <Container key={item.id} layout="horizontal" gap="xs" alignItems="center">
      <ColorDot color={item.color} label={item.label} size="sm" />
      <Text>{item.label}</Text>
    </Container>
  ))}
</Container>
```

### Chart Legend

```tsx
<Container layout="horizontal" gap="lg" wrap>
  {chartData.map((series) => (
    <Container key={series.id} layout="horizontal" gap="xs" alignItems="center">
      <ColorDot color={series.color} size="md" />
      <Text>{series.label}</Text>
    </Container>
  ))}
</Container>
```

## Files

| File | Purpose |
|------|---------|
| `ColorDot.tsx` | The dot: CVA sizes, `color` (inline data colour) or `tone` (palette id painted by screen-look) |
| `index.ts` | Barrel export: `ColorDot`, `colorDotVariants`, `ColorDotProps` |

## Dependencies

- **Depends on:** `class-variance-authority`, `../cn`; `tone` dots are painted by `parts/screen-look/show/coss-workspace.css` (`[data-colour]` rules over the `--record-kind-<id>` hues).
- **Depended on by:** `color-tag-picker-overlay`, `rich-text-toolbar`, `visual-layer-stack`, `parts/guided-overlay`, `parts/addressed-marks`, and the Spaces screen's colour menu (`src/workspace/spaces-screen.tsx`).
