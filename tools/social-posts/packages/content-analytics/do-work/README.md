# Content Analytics Do Work

This folder owns the action boundary for the package surface.

`content-analytics-actions.ts` turns descriptor data plus selected model context
into an owner-action request. It never writes owner records directly. The default
target is `slot::workflow` with `execute_definition`; tests inject the sender so
the request shape is proved without side effects.

`read-provider-post-performance.ts` calls the declared provider-read workflow.
The workflow re-reads the exact published status and enabled source, then uses
the source's collection profile to select a saved read operation and response
fields. Service Connections enforces GET/HEAD. Only profile-selected numeric
metrics and comment fields are persisted; missing metric values stay absent.
