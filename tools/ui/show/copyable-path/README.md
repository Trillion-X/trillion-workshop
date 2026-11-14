# CopyablePath Component

## Purpose

Canonical clickable file path component with copy-to-clipboard functionality. Displays a shortened version of file paths (configurable segment count), shows full path on hover, and provides visual feedback on copy success.

## Files

| File | Purpose |
|------|---------|
| `CopyablePath.tsx` | Main component with CVA variants for size/variant styling |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|------------------|------|
| `CopyablePathProps` | `{ path: string; displaySegments?: number; showFullOnHover?: boolean; onCopy?: () => void; variant?: VariantProps<...>; size?: VariantProps<...> }` | Props interface extending CVA variants and native div attributes |
| `CopyablePath` | `React.FC<CopyablePathProps>` | Main component, forwardRef enabled |

## Dependencies

**Depends on:**
- `class-variance-authority` — CVA for variant composition
- `lucide-react` — Copy, Check icons
- `../cn` — classname merge utility
- `../icon` — Icon component wrapper

**Depended on by:**
- `FileHeader` component in `packages/file-viewer/show/`
- ui/index.ts barrel export

## Behavior

- **Display:** Shows last N segments of path (default 1 = just filename)
- **Hover:** Full path appears as title attribute (native browser tooltip)
- **Click:** Copies full absolute path to clipboard via `navigator.clipboard.writeText()`
- **Visual Feedback:** Icon switches from Copy → Check for 1500ms after successful copy
- **Font:** Always mono for file paths (consistent rendering)
- **Keyboard:** Enter/Space keys trigger copy action
- **ARIA:** Proper role="button", tabIndex, aria-label for accessibility

## Usage

```tsx
import { CopyablePath } from '@/packages/ui';

// Filename only (default)
<CopyablePath path="/srv/project/src/index.ts" />

// Last 2 segments (directory/file)
<CopyablePath
  path="/srv/project/src/index.ts"
  displaySegments={2}
/>

// Custom variant and size
<CopyablePath
  path="/srv/project/src/index.ts"
  size="md"
  variant="subtle"
  onCopy={() => console.log('copied')}
/>
```

## Design System

- **Sizing:** sm (text-xs), md (text-sm)
- **Variants:** default (white/70 hover white), subtle (white/60 hover white/80)
- **Fonts:** font-mono (always, no exceptions — file paths are code)
- **Icons:** Copy/Check from lucide-react, rendered via Icon component
