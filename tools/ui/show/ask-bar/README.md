# ui/show/ask-bar

One rounded text field with a send button, for asking or adding something by typing: optional suggestions under it and optional extra actions beside it.

## Files

| File | Purpose |
|------|---------|
| `AskBar.tsx` | The React control: auto-growing textarea, leading icon, action group (ExpandableTabs), send button, suggestion chips. Enter sends, Shift+Enter makes a new line. |
| `mount-ask-bar.tsx` | `mountAskBar(host, props)`: renders AskBar into a DOM host for pages that are not React; one root per host, reused on every call. |
| `dom-composer.mjs` | DOM composer helpers used by existing non-React composer pages. |
| `index.ts` | Barrel: `AskBar`, `mountAskBar`, and the prop types. |
| `AskBar.test.tsx` | Send button, busy blocking, Enter vs Shift+Enter, caller actions and send label. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `AskBar` | `forwardRef<HTMLTextAreaElement, AskBarProps>` | The control. Controlled with `value` + `onValueChange`, or uncontrolled with `defaultValue`. |
| `AskBarProps` | `{onSubmit, value?, defaultValue?, placeholder?, ariaLabel?, suggestions?, onAttach?, onVoice?, actions?: {id,label,icon}[], onAction?(id), leadingIcon?, submitLabel?, disabled?, busy?}` | `actions` are DATA drawn beside attach and voice; `leadingIcon` is a Lucide name; `submitLabel` names the send button for screen readers. |
| `AskBarSuggestion` | `{id, label, prompt?}` | A chip under the bar that fills the field. |
| `mountAskBar` | `(host: HTMLElement, props: AskBarProps) => () => void` | Mount or re-render in place; the returned function unmounts. Exposed to app pages as `ExpansionControls.mountAskBar`. |

## Dependencies

**Depends on:** `ui/show/button`, `ui/show/container`, `ui/show/expandable-tabs`, `ui/show/icon` (NamedIcon, Lucide), `ui/show/input` (Textarea), `ui/show/text`, `react`, `react-dom/client`.

**Depended on by:** media-workspace `shared-controls-entry.ts` (`mountAskBar`), whose Formats page (`example-library.mjs`) uses it for pasting links and for writing a version of a saved example.
