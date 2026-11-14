# Form

Canonical form wrapper component for AICC.

## Files

| File | Purpose |
|------|---------|
| `Form.tsx` | Wraps native HTML `<form>` element to enable L065 compliance in feature code |

## Key Types

| Type | Signature | Role |
|------|-----------|------|
| `FormProps` | `extends React.FormHTMLAttributes<HTMLFormElement>` | Props interface supporting all native form attributes |
| `Form` | `(props: FormProps) => JSX.Element` | Form wrapper component |

## Dependencies

**Depends on:**
- React (peer dependency)

**Depended on by:**
- `frontends/web/src/packages/pages/SettingsPage.tsx` — settings form
- `frontends/web/src/packages/pages/PricingPage.tsx` — payment form
- `frontends/web/src/packages/ui/index.ts` — barrel export for ui/ components

## Why This Design

Feature code never uses raw `<form>` HTML elements. All forms use `<Form>` component for consistent structure and to maintain L065 zero-inline-styling compliance.
