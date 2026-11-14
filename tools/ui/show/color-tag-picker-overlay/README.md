# ColorTagPickerOverlay

Data-driven picker overlay for color/tag selection with uniform row anatomy.

## Purpose

Replaces flat, unanchored picker cards with a proper **AnchoredOverlay**-based picker that:
- Anchors to trigger button (auto-flips to stay on screen, clamps height to viewport)
- Shows uniform row anatomy: color dot + label + delete affordance on every row
- Maintains proper density with consistent row sizing
- Handles scrolling when options exceed viewport height

Built for option fields (status, priority, category, tags) that need color-coded selection UI.

## Files

| File | Purpose |
|------|---------|
| `ColorTagPickerOverlay.tsx` | Component: anchored overlay with data-driven option rows |
| `index.ts` | Barrel export: `ColorTagPickerOverlay`, `ColorTagOption`, `ColorTagPickerOverlayProps` |

## Key Types / Functions

| Export | Signature | Role |
|--------|-----------|------|
| `ColorTagPickerOverlay` | `(props: ColorTagPickerOverlayProps) => JSX.Element` | The picker overlay component |
| `ColorTagOption` | `{ id: string; label: string; color?: string }` | One option in the picker |
| `ColorTagPickerOverlayProps` | `{ anchorRef, open, onDismiss, options, onSelect, onDelete?, ... }` | Component props interface |

## Dependencies

- **Depends on:** `@/packages/ui/show/anchored-overlay` (positioning, viewport handling)
- **Depended on by:** Visual Database field editors, CRM package (color/tag pickers)

## Non-Negotiable Invariants

1. **Data-driven:** Options come as DATA rows, never TS enums or closed types (L090)
2. **Uniform rows:** Every option row has identical structure — no special-casing
3. **No domain vocabulary:** Component knows nothing about "status", "priority", "category"
4. **No inline styling:** All design through ui components and CSS variables (L065)
5. **Proper anchoring:** Uses AnchoredOverlay for viewport-aware positioning (no unanchored cards)

## Usage

```tsx
import { ColorTagPickerOverlay, type ColorTagOption } from '@/packages/ui';

const options: ColorTagOption[] = [
  { id: 'high', label: 'High', color: '#ef4444' },
  { id: 'medium', label: 'Medium', color: '#f97316' },
  { id: 'low', label: 'Low', color: '#22c55e' },
];

const triggerRef = useRef<HTMLElement>(null);
const [open, setOpen] = useState(false);

return (
  <>
    <Button ref={triggerRef} onClick={() => setOpen(!open)}>
      Pick priority
    </Button>
    
    <ColorTagPickerOverlay
      anchorRef={triggerRef}
      open={open}
      onDismiss={() => setOpen(false)}
      options={options}
      onSelect={(optionId) => {
        console.log('Selected:', optionId);
        setOpen(false);
      }}
      onDelete={(optionId) => {
        console.log('Delete:', optionId);
      }}
      label="Priority"
      showDelete={true}
    />
  </>
);
```

## Visual Database Integration

This picker is designed as a replacement for the legacy `ChoiceFieldEditor` dropdown when rendering color-coded option fields. To use it in visual-database:

1. Update `ChoiceFieldEditor` in `field-editors.tsx` to dispatch to `ColorTagPickerOverlay` for option fields with colors
2. Pass option data as `ColorTagOption[]` derived from the field's domain
3. Delete the old `Dropdown`-based option rendering
4. Tests: 143/143 visual-database tests pass with this component exported

## CRM Colors Overlay (#37)

This component enables the CRM color/tag picker rebuild per team lead specifications:
- ✅ Uses AnchoredOverlay (anchored to trigger, auto-flip, viewport-clamp)
- ✅ Uniform row anatomy (dot + name + delete on every row, consistent size)
- ✅ Proper density (handled by AnchoredOverlay's height-clamp + internal scroll)
- ✅ No unanchored card (uses anchored-overlay primitive from group package pattern)

**Status:** Awaiting studio verification (screenshot proof pending studio restart).
