# automation-preview

The hover card of a setting or control that something automatic stands behind (a rule, a schedule or a workflow): resting on it or focusing it shows a small still graph of what it does, and pressing it opens that automation in its editor.

## Files

| File | Purpose |
|------|---------|
| `AutomationPreview.tsx` | The card (Base UI PreviewCard): the trigger around the caller's words or control, the graph read once per id, "Open to edit"; the one app source (`setAutomationPreviewSource`) that reads, draws and opens. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `AutomationPreview` | `({automationId, title, children, side?, delay?}) => JSX` | Wraps words or a control; hover or focus opens the card, a press opens the editor (a control that handles its own press stops it). |
| `setAutomationPreviewSource` | `(source: AutomationPreviewSource) => void` | The app's one way to read an id's graph, draw it and open it; set once, shared by every card on the page. |
| `forgetAutomationPreview` | `(id: string) => void` | Forgets one id's graph after it changed, so its next card reads it again. |
| `AutomationMarks` | `({automations?: BackingAutomation[]}) => JSX \| null` | One small mark per automation behind a heading or column name (record-views `FieldDescriptor.automations`, Dashboard card `automations`), each opening its own card. |
| `BackingAutomation` | `{id: string; label: string; on?: boolean}` | Something automatic a setting stands on, as the screen's DATA names it. |
| `AutomationPreviewSource` | `{read(id) => Promise<AutomationPreviewGraph>, drawGraph(graph) => ReactNode, open(id, title) => void}` | What the app hands in. |
| `AutomationPreviewGraph` | `{title, says?, source}` | What a card draws; `source` is the app's own (Trillion hands a board source, drawn as a still picture of the board). |

## Dependencies

**Depends on:** `@base-ui/react/preview-card`, `../coss/ui/button`, `../icon`, `../layer-order`.

**Depended on by:** `../coss/guide.tsx` (a guide item's `automations`), Trillion's Automations list (`src/workspace/workflows-screen.tsx`) and its source (`src/workspace/automation-preview-source.tsx`, which draws with `parts/workflow-canvas` StepGraph `still`). Appearance: `screen-look/show/automation-preview.css` and the record-preview card look.

## Invariants

- Names no automation, route or drawer: the app's source does; this part only places the card.
- A graph is read when its card first opens, then kept for the page until forgotten.
