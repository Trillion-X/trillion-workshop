# account-dashboard/data

Machine-readable package data for Account Dashboard.

`account-surface-descriptors.json` owns account-facing labels, owner target
names, source matching, action payload mappings, freshness metadata, and
render-state fixture names. Executable source consumes this data through the
generic surface materializer/action builder and must not copy these terms into
code branches.
