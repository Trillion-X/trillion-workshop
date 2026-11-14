# browser-session-actions

This package owns browser-intent routing DATA, not a connector or browser-control
protocol.

- Authenticated browser work selects the declared `computer-interface-actions`
  provider whose DATA promises a task-isolated agent screen. CLI availability is
  insufficient: the returned proof must include a stable surface identity,
  task isolation, independent pointer and keyboard ownership, and an input-focus
  identity before the route is usable.
- Public, unauthenticated headless work selects the declared isolated headless
  provider through the same canonical computer-interface owner.
- A visible personal browser is ineligible by default. Even an exact request from
  the declared founder authority can select only an exact provider/session declared in current DATA; this
  package never invents or discovers a personal browser fallback.
- Local CDP discovery is forbidden. This package does not scan ports, inspect
  running browser processes, connect sockets, launch browsers, or execute page
  actions.

The runner projects a route and optionally validates surface proof:

```bash
node packages/browser-session-actions/do-work/run-browser-session-action.mjs --input-json request.json
```
