# ui/diff-view/

Reusable unified diff viewer component with line-number gutter and virtual scrolling.

## Files

| File | Purpose |
|------|---------|
| `DiffView.tsx` | React component rendering unified diff with color-coded lines (red/green/neutral) and line-number gutter. Uses `@tanstack/react-virtual` for >100 lines |
| `diff-logic.ts` | Pure `computeUnifiedDiff(before, after)` function and `DiffLine` type |
| `index.ts` | Barrel export for DiffView and DiffViewProps type |

## Key Types

| Type | Signature | Role |
|------|-----------|------|
| `DiffViewProps` | `{ lines: DiffLine[], maxHeight?: number, className?: string }` | Props for DiffView component |
| `DiffLine` | `{ type, content, oldLineNumber?, newLineNumber? }` | Single line in a unified diff |

## Usage

```typescript
import { DiffView } from '@/packages/ui';
import { computeUnifiedDiff } from '@/packages/ui';

// Compute diff from two strings
const lines = computeUnifiedDiff(oldCode, newCode);

// Render with DiffView
<DiffView lines={lines} maxHeight={384} />
```

## Styling

- **Added lines:** `bg-emerald-500/10 text-emerald-300`
- **Removed lines:** `bg-red-500/10 text-red-300`
- **Unchanged lines:** `text-white/60` (subtle)
- **Container:** `glass-tertiary` (bg-white/5, border-white/10) + monospace font (font-mono text-xs)

## Performance

- Virtual scrolling enabled for diffs >100 lines
- Non-virtual rendering for small diffs (<100 lines)
- Renders only visible items + 10-line overscan buffer
- Memory-efficient: O(visible lines) instead of O(total lines)

## Dependencies

**Depends on:** `@tanstack/react-virtual` (for virtualization), `react` (hooks + components), `../cn` (class merging utility)

**Depended on by:** `chat/view/ToolRendererDiff.tsx`, re-exported from `ui/index.ts`
