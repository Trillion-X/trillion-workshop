# Shared table

`TableColumnResizeHandle` is a controlled separator for a table header. Pass
the current `width`, optional `minWidth`/`maxWidth` bounds, and an `onResize`
callback that updates the table owner's visible width. It reports the final
width to `onCommit` after a drag or arrow-key change so the owner can save user
preferences without coupling this generic component to a storage system.

The handle supports pointer dragging, `ArrowLeft` and `ArrowRight`, pointer
cancellation, and an accessible separator name and current width. Its header
cell must establish a positioning context. `record-views` is the current
consumer and stores committed widths with its other view preferences.

Focused behavior is covered by
`../record-views/record-views.test.tsx`: keyboard resize survives remount, and
pointer resize updates the visible width, clamps at the maximum, and persists
only the changed field.
