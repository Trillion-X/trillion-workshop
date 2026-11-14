# ui/show/collapsible-panel/

Pure browser-local collapsible panel visual primitive.

## Boundary

- Owns only local pointer/resize rendering mechanics.
- Applies width transitions only for non-drag collapse/expand; pointer dragging
  writes width immediately so the panel does not animate behind the cursor.
- Does not read addressed data.
- Does not invoke slots or engine targets.
- Does not persist collapse or width state; callers own durable state.
