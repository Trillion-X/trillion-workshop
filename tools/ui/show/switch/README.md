# Switch

The one on/off switch every screen uses: a pill track that fills from the left as it turns on, and a white pill thumb that slides across it.

## Files

| File | Purpose |
|------|---------|
| `Switch.tsx` | The switch on Base UI's Switch primitive; names its parts (`.ui-switch`, `.ui-switch-thumb`), stops a press from reaching the row it sits in. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `Switch` | `(props: SwitchProps) => JSX` | The switch. |
| `SwitchProps` | `{ checked: boolean; onCheckedChange: (checked: boolean) => void; label?: string; disabled?: boolean; size?: 'sm' \| 'md'; className?: string }` | `label` is the accessible name when nothing visible names it; `md` (default) is 44 by 20, `sm` 36 by 16. |

## Usage

```tsx
import { Switch } from '../../parts/ui';

<Switch label="Daily digest on" checked={on} onCheckedChange={setOn} />
```

## Accessibility

- Base UI gives `role="switch"`, `aria-checked`, Space and Enter, focus-visible and disabled.
- Reduced motion moves the thumb without animation.

## Appearance

`screen-look/show/switch.css`: the track's two-colour gradient slides (`--switch-color` on, `--switch-muted` off), the thumb eases on in 250 ms and off in 125 ms; sizes are CSS variables per `data-size`.

## Dependencies

**Depends on:** `@base-ui/react/switch`, `../cn`.

**Depended on by:** `../coss/ui/switch` (re-export, used by `../coss/guide.tsx` action switches), the Automations screen (`src/workspace/workflows-screen.tsx`) through `../record-views` cells.

## References

21st.dev component 21948 (serafimcloud/switch, MIT): gradient track and spring-eased pill thumb, adapted into plain CSS.
