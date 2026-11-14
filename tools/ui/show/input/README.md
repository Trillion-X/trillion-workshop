# ui/show/input/

Canonical browser-local input controls shared by Bitfield Studio package surfaces.

| Path | Purpose |
|---|---|
| `Input.tsx` | Glass-token text input with optional label, error text, and centered left icon slot. |
| `Textarea.tsx` | Glass-token multiline input with associated label, matching error behavior, and forwarded refs. |
| `index.ts` | Barrel export for input controls and types. |

## Boundary

The input controls are pure visual leaves. They do not own validation policy,
durable state, package data, or target invokes. Callers own draft state,
commit timing, parsing, and domain meaning.

Labels are associated with controls through generated ids when callers do not
provide one, so package tests and assistive technology can address the fields by
their visible labels.
