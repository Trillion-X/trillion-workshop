# record-kind

One mark that says what kind of thing a media record is: an original recording, an edit project, an exported video, a draft, or any kind a producer writes.

| File | Purpose |
|------|---------|
| `RecordKindMark.tsx` | The kind mark (icon, short label, tone), the state mark (coloured dot, label worded for the kind) and the text/value forms used by filters and columns. |
| `RecordKindMark.test.tsx` | Every styled kind draws from DATA; original and project differ; unknown kinds still draw; states are worded per kind, then shared, then from the key. |
| `index.ts` | Barrel. |

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `RecordKindMark` | `({kind, detail?, compact?}) => JSX` | Draws the kind; nothing when there is no kind. |
| `recordKindLabel` | `(kind, detail?) => string` | "Project · Premiere Pro"; the value columns filter, sort and group on. |
| `recordKindAppearance` | `(kind) => {label, icon, tone}` | DATA row or fallback with the key made readable. |
| `recordKindValues` | `() => Record<kind, {label, tone}>` | Every styled kind as filter values. |
| `RecordStateMark` | `({kind?, state?, problem?}) => JSX` | A record's `record_state` with a dot; `problem` is the hover text. |
| `recordStateLook` | `(kind, state) => {label, tone}` | `kind_states[kind][state]`, then `states[state]`, then the key made readable. |
| `recordStateValues` | `() => Record<state, {label, tone}>` | Every shared state as filter values. |

The kind is the record's own `record_kind`, written by its producer. Labels, icons and tones are screen-look DATA in `packages/screen-look/show/record-kind-appearance.json`; tone colours are `--record-kind-*` in `screen-look/show/coss-workspace.css`.

**Depends on:** `icon/NamedIcon`, `coss/ui/badge`, screen-look `record-kind-appearance.json`.
**Depended on by:** `coss/workspace-controls.tsx` (`recordKindContent`, `mountRecordKind`, `recordKindLabel`), `coss/project-tree.tsx`, screen-arrangement `ContainerHeader.tsx` (tab kind), Expansion Library, Schedule, preview tabs.
