# file-work-action/

Generic file action control for package work loops.

It lets a caller render a drop/pick area plus one primary start button. The component owns only local selection state and caller-owned copy. It does not stage bytes, submit workflow actions, read package data, import file-provider packages, or know package names.

Callers can pass `pickFiles` when the package owns a native picker bridge. `FileWorkAction` still treats it as an opaque provider and can run one or many accepted files through the same `onStart` work loop.
