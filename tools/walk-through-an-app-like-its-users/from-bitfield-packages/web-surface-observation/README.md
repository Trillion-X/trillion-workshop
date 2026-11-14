# web-surface-observation/

Drive a running web surface through a declared sequence of steps and report what it actually rendered.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package manifest. Declares the `observe-a-running-web-surface` capability, the `do-work` public source, and the checks descriptor. |
| `do-work/observe-surface.mjs` | The owner. Dispatches steps and observations through capability maps and returns one JSON readback. |
| `tests/observe-a-running-web-surface.test.mjs` | Checks the runner's discipline against a fake page: blocked steps are reported not thrown, observations survive a failed step, a step label can never become an accessible name. |

## Key types and functions

| Export | Signature | Role |
|---|---|---|
| `ACTIONS` | `Record<string, (page, step) => Promise<void>>` | What a step can do: `goto`, `click`, `fill`, `press`, `wait_for`, `wait_ms`, `screenshot`. |
| `OBSERVATIONS` | `Record<string, (page, spec) => Promise<any>>` | What a step can read: `elements`, `count`, `media_ready`, `text`. |
| `locate` | `(page, step) => Locator` | Resolves `selector`, or `role` plus `role_name`, or `text`. |
| `observe` | `(plan, {chromium}) => Promise<readback>` | Runs a plan and returns `{url, page_errors, steps[]}`. |
| `run` | `(argv) => Promise<readback>` | Reads a plan file, runs it, optionally writes the readback. |

## Usage

```
node do-work/observe-surface.mjs --plan <plan.json> [--readback <out.json>]
```

A plan is DATA:

```json
{
  "url": "http://127.0.0.1:8793",
  "steps": [
    {"name": "open Library", "do": "click", "role": "button", "role_name": "Library"},
    {"name": "settle", "do": "wait_ms", "ms": 2000,
     "observe": {"menu": {"read": "elements", "selector": "[role=menuitem]", "limit": 20}}}
  ]
}
```

## Invariants

- Nothing is asserted and nothing fails. A step that cannot complete is recorded
  with `completed: false` and `blocked_by`, and the run continues, because a run
  that aborts halfway hides the state that explains the failure.
- Observations run even when the step before them was blocked. That is usually
  the only way to see why it was blocked.
- No application, route, selector, label or product name appears in this source.
  All of it is fields of the plan.
- There is no way to intercept, stub or route the page. A check that mocks its
  own subject observes nothing, which is the failure this package exists to
  prevent.

## Why this design

A suite can be green while the product is unusable, and the usual cause is that
the checks replaced the app with a stub before asking whether the app works.
This owner can only look at a running surface. The most load-bearing field it
reports is `pointer_is_self`: whether a pointer aimed at an element's own centre
would actually land on that element. That single fact separates "the control is
missing" from "the control is there and something is covering it", which no
snapshot or unit check can distinguish.

## Dependencies

**Depends on:** `playwright` (imported lazily, only when `run` executes), `node:fs/promises`, `node:path`.

**Depended on by:** any lane that must prove a user-interface claim against the running product.
