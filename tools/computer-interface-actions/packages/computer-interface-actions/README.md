# computer-interface-actions

One generic owner for bounded actions against a computer's interface (apps, windows, CLIs). Provider identity is DATA; every concrete target is a provider configuration, never a package branch.

## Boundary

This package owns bounded computer-interface action validation, provider DATA planning, sensitive-action human approval gates, task-surface proof gates, and non-secret result projection. External execution belongs exclusively to `compute.process_session`. It never owns passwords, cookies, tokens, or credentials.

## Current provider DATA

- `aside` / `official_cli`: the authenticated-browser route. It invokes only
  the documented CLI, reports `restricted` when unavailable, and never falls
  back to daemon, CDP, socket, or visible-personal-browser control.
- `obscura` / `headless_browser`: public headless fetch and screenshot work in
  an isolated non-display context. It is not an authenticated-session route.
- `macos-ui` / `apple_script`: explicit host-visible UI work. Provider DATA
  marks it ineligible for authenticated-browser selection.

## Front door

`action:computer-interface-execute` prepares the invocation from current provider
DATA, passes the executable as a runtime alias, and delegates it to
`compute.process_session`. It never discovers an executable through ambient
`PATH` and never launches a provider child from the package's Node planner.

`action:computer-interface-end-session` ends one exact returned session. Stable
effect keys bind the caller event to the exact normalized action, so replay does
not duplicate an external effect and a changed action cannot collide with a prior
request.

Authenticated execution fails closed until the provider result names the task
surface, isolation scope, independent pointer, independent keyboard, and
independent focus. Visible personal displays are ineligible for the generic
execution action.

Sensitive operations require an exact approval object with
`approved_by_ref`, `action_hash`, and `target_identity`. The authority reference
must be declared by the selected provider DATA row.
