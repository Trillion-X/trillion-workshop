# TaskRecurrence

`TaskRecurrence` is a controlled shared editor for a repeating task rule. It accepts the task's frequency choices, weekday choices, follow-on task choices and all visible words as caller data. The component only emits a new value; it does not store a rule, calculate occurrence dates or create tasks.

The supplied Amie pixels show a Repeat action on an expanded task card and in its task menu (inventory image 82). They do not show the repeat editor's interval, weekday, end-condition or follow-on-task controls. Those controls are Trillion's own data-driven editor, built with its licensed shared Switch, Checkbox, Input and Select components. No upstream code was copied.

The 21st.dev registry MCP was not available in this session, so no live component lookup or component ID is claimed. The search that remains relevant is `task recurrence editor interval weekdays end date`; the local source set and existing shared calendar controls were inspected.

The saved Amie reference is used for behavior and hierarchy, not as a code source. Appearance remains in `parts/screen-look/show/schedule-calendar.css`.
