# Nested navigation

`NestedNavigationPicker` opens a searchable phone-sized bottom sheet. `NestedNavigationList` renders arbitrary collection depth with disclosure buttons, a current row, and disabled rows. The caller supplies collection data and owns the selection action; the component does not decide access.

Appearance is owned by `packages/screen-look/show/nested-navigation-style.ts`. The shared UI component mounts that style with the sheet because the stored entry bundler does not load CSS module sidecar output.

The Community Library is the first consumer. Its course graph comes from `access-scoped-content`; neither course names nor Shadcn code are stored here.
