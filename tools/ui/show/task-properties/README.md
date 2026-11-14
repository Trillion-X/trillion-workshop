# Task properties

`TaskProperties` is a controlled shared editor for a task's description, priority, labels and optional parent/subtask relationships. It uses the existing shared `Input`, `Textarea`, Coss `Select` and Coss `Checkbox` controls. The Coss controls are covered by the pinned MIT license record in [`parts/ui/show/coss/provenance.json`](../coss/provenance.json) (upstream commit `e937becd2d5ffb5c621eed6f8b1f223cbb6051e7`); this part composes their existing API and copies no upstream code.

The compact checklist hierarchy follows supplied Amie reference #86, described in [`docs/amie-rebuild-reference.md`](../../../../docs/amie-rebuild-reference.md). It informs visible anatomy only; no proprietary screenshot text or implementation is included here.

## API

| Name | Shape | Role |
| --- | --- | --- |
| `TaskProperties` | `(props: TaskPropertiesProps) => JSX` | Renders description, a caller-provided priority list, and searchable label choices. |
| `TaskPropertiesProps` | `{description, priority, priorityOptions, selectedLabels, labelOptions, labelQuery, words, onDescriptionChange, onPriorityChange, onLabelsChange, onLabelQueryChange, supportingProperties?, disabled?, className?}` | All values and writes are controlled by the caller. Label changes emit the full next label array. A selected label absent from `labelOptions` remains visible so it can be removed. `supportingProperties` accepts caller-composed, already-labelled shared controls and appears in the compact property row. `descriptionFormats` (`{label, commands}`) shows the shared selection format bar above the description while words in it are selected, and writes the marks into the text. |
| `TaskPriorityOption` | `{value, label}` | A caller-provided priority value and its display copy. An empty value is reserved for the explicit no-priority choice. |
| `TaskPropertiesWords` | `{description, descriptionPlaceholder, priority, priorityPlaceholder, noPriority, labels, findLabel, findLabelPlaceholder, noLabels, noMatchingLabels}` | Every visible string comes from the caller. |

The part owns no task records, label creation, persistence, optimistic state or product vocabulary. The caller supplies current values and performs the resulting writes through its task owner.

`renderPieces` optionally receives the existing controlled fields as stable `{ id, label, content }` rows; `additionalPieces` supplies caller-owned controls alongside them. The caller may place these through the existing screen arrangement engine. Rendering a piece keeps the same callbacks, values and validation. Conditional parent/subtask rows keep their identities while their content is absent, so an arranged consumer can retain its placement. The default renderer remains available.

## Use

```tsx
<TaskProperties
  description={task.description}
  priority={task.priority}
  priorityOptions={priorityOptions}
  selectedLabels={task.labels}
  labelOptions={labelOptions}
  labelQuery={labelQuery}
  words={words}
  onDescriptionChange={description => updateDescription(task.id, description)}
  onPriorityChange={priority => updatePriority(task.id, priority)}
  onLabelsChange={labels => updateLabels(task.id, labels)}
  onLabelQueryChange={setLabelQuery}
/>
```

## Screen Look

The component uses existing look tokens and shared control styling. Its optional `compact` presentation keeps the description on one row, then groups parent, priority, labels and caller-supplied supporting properties into a horizontal row that wraps to fit narrow cards. Compact controls are 2rem tall with .375rem row gaps; subtasks keep their full-width checklist presentation above the property row. Searchable labels stay in the existing Coss popover. Appearance remains in `parts/screen-look/show/schedule-calendar.css`. The parent and priority controls are non-modal so the task card stays usable while their choices are open. Every built-in control keeps its visible or accessible name; callers must supply accessible names for controls passed through `supportingProperties`.

The optional `parent` value/options/callback and `subtasks` row identities and open/check/add callbacks remain controlled by the caller. Paging notices avoid presenting partial relationships as complete. Child completion is independent. Subtask rows reuse Screen Look checklist classes; adapters retain drafts when opening related tasks. The Amie reference image shows task actions as adjacent compact chips beneath the subtask list. The supplied task-detail source preview is narrower, so the same property controls wrap instead of overflowing. 21st.dev searches for `compact task editor inline details spacing` and `compact task action toolbar pill buttons duration recurrence inline scheduling` found no fitting task-property editor; the returned Inline Edit (10478), task-list (9159, 23793) and action-toolbar (19517, 30343, 31776) patterns do not solve this multi-field composition, so no registry code was used. Mobbin search tools were unavailable in this session.

The 21st.dev search `compact task editor subtasks labels` returned component 9159, inspected as an anatomy reference only. The shared part retains the pinned MIT Coss controls and copies no registry implementation. Mobbin was unavailable in this session.

Compact callers may supply `moreLabel` and `overflowProperties`. The short action row then offers the optional subtask action (with `addShortLabel` and its full accessible name), caller timing controls, and one anchored overflow panel containing parent, priority, labels and the caller fields. The same retained Coss popover keeps drafts; Escape closes it and returns focus. Notes use the shared borderless auto-growing Textarea, so longer text stays readable. Calendar uses this to expose duration as a labelled chip, Repeat alongside it, and deadline/scheduling/delete in More task options. Screen Look owns the compact chip appearance. 21st.dev Menubar Compact component29428 was inspected for overflow anatomy only; no registry source was copied. Mobbin tools were unavailable.
