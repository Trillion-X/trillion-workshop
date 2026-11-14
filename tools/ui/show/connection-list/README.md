# connection-list

One settings section listing connections to outside services: each row shows the service mark, its name with one line of detail, the formats it offers, its current state and one action, with an optional "N of M connected" summary.

## Files

| File | Purpose |
|------|---------|
| `ConnectionSection.tsx` | The section component and `connectionStateLook`, which reads state labels and tones from screen-look DATA. |
| `ConnectionSection.test.tsx` | Rows, state labels (including an unknown state), tags, action callback, summary count and empty text. |
| `index.ts` | Public exports. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ConnectionSection` | `(options: ConnectionSectionOptions) => JSX.Element` | Renders the section card. |
| `ConnectionSectionOptions` | `{title, description?, rows, emptyText?, summarizeState?, registry?, onAction?(rowId, actionId)}` | Caller input. |
| `ConnectionRow` | `{id, name, detail?, providerSlug?, state?, tags?, action?}` | One service; `state` is derived by the caller from real checks. |
| `ConnectionAction` | `{id, label, opensOutside?, tone?: 'default' \| 'danger'}` | The row's one action. |
| `connectionStateLook` | `(state?) => {label, tone}` | State appearance from `screen-look/show/connection-state-appearance.json`; unknown states draw with a readable label and the fallback tone. |

## Dependencies

**Depends on:** `provider-mark` (service marks from the provider-icon registry), `coss/ui` Badge and Button, `screen-look/show/connection-state-appearance.json`, `screen-look/show/coss-workspace.css` (`connection-section*` classes).

**Depended on by:** `coss/workspace-controls.tsx` (`mountConnectionSection`), Expansion's publishing accounts page.

## Invariants

- The component never infers a state; no service is named in its code.
- References: Vercel sign-in methods and Linear connected workspaces (Mobbin), Buffer connected channels (Mobbin), 21st.dev "Integrations 02" (id 22082).
