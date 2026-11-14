# QuickCreate

A compact title-entry row composed from the shared licensed Input, Button and Text controls. The caller supplies all copy, the create action and its secondary destination. A failed create retains the title; rejected callbacks show the supplied error copy. Busy state prevents repeat submissions, and settled work does not update an unmounted row. Persistence and request identity remain with the caller. Appearance is owned by parts/screen-look.

`compact` uses a single capture surface with an accessible submit icon. Optional `expandLabel` and `onExpand` expose the caller’s detailed creation screen without adding a second toolbar action. Enter submits after text composition finishes; a synchronous in-flight guard rejects duplicate presses. Caller copy and persistence remain unchanged.

`focusRequest` focuses the field each time its count grows (a key that jumps to it). `preview(value)` returns a line said under the field about what the typed words will do (a list or a time they name); null says nothing.
