# tools/walk-a-new-person-through-first-setup/

Walk a new person through first setup: the apps to install on their devices, the AIs to connect, and the saved run that resumes where they stopped. The tool is a projection: the caller reads the saved run, the account's access prerequisites, what the account already has, its computers and the person's pursuit lens from their own records, and hands them over. Nothing here reads storage or the clock, and nothing is written.

Ported from old trillion `src/setup-plan.mjs` and `src/setup-installs.mjs` at tag `old-trillion-before-worker-retire` (b6ae0ebf81). The row is `tool:walk-a-new-person-through-first-setup` in `tool-rows.json`.

## What the old files became

| Old file | Decision | What happened |
|---|---|---|
| `src/setup-plan.mjs` | Ported in part | `setupPlan` and `setupInstructions` are `do-work/setup-plan.mjs`. The policy is `read-data/setup-policy.json` (copied byte for byte from the tag). The lens is handed in as `lens` instead of a module-level `useLens`. `setupTools` (the MCP `start_setup` and `read_setup` surface and its HTTP reads of `/setup/runtime`, `/setup/requirements`, `/pursuits`, `/connections`, `/network/ensure-profile`, `/setup/devices`, `/computer-sources` and `/agents/find`) is not carried: the caller reads those and hands them in, and the Workshop row is the surface. |
| `src/setup-installs.mjs` | Ported | `do-work/setup-installs.mjs`, with its imports pointed at the Workshop folders that now hold the same modules. |
| `src/setup-runtime.mjs` | Held | `from-old-trillion/src/setup-runtime.mjs.held`. It is the saved run's write path (preparing and resuming the workflow run). Not ported yet. |
| `src/setup-policy.json` | Ported | `read-data/setup-policy.json`. |
| `test/setup-plan.test.mjs`, `test/setup-runtime.test.mjs` | Held | Still in `from-old-trillion/test/`. The plan's own behaviour is tested by `test/walk-a-new-person-through-first-setup.test.mjs`. |

## Gap

`start_setup` is the write path that starts or resumes the saved run. Its decision is now `tool:start-or-resume-the-first-setup` (`do-work/start-or-resume-the-first-setup.mjs`): it returns the ordered owner calls, each with a read-back, and writes nothing. The runner that makes those calls is the caller's, so the old `src/setup-runtime.mjs` stays held. The plan's own words still say `start_setup` and `read_setup` (the old MCP names) until the plan names the Workshop tool ids.

## Files

| File | Purpose |
|------|---------|
| `do-work/walk-a-new-person-through-first-setup.mjs` | `tool:walk-a-new-person-through-first-setup`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `do-work/setup-plan.mjs` | `setupPlan({ runtime, known, prerequisites, native, origin, view, lens })`: the plan. |
| `do-work/setup-installs.mjs` | `setupInstalls(origin, native)`: the device apps step and the harness setup (download, inspect, apply, remove per supported host, MCP registration preview). |
| `read-data/setup-policy.json` | The setup policy (goal, principles, workflow steps). |
| `do-work/start-or-resume-the-first-setup.mjs` | `tool:start-or-resume-the-first-setup`: the ordered owner calls for starting or resuming the saved run, each with its read-back. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/start-or-resume-the-first-setup.test.mjs` | Tests for the start or resume plan: fresh, unavailable owners, done steps, stopped, stuck resume, finished and refusals. |
| `test/walk-a-new-person-through-first-setup.test.mjs` | Tests for the plan: state and full views, http and https origins, the lens, the stopped setup, entry points and refusals. |
| `part.json` | The two modules a caller may import. |
| `from-old-trillion/` | The held files not yet ported, with their receipt. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `walkAPersonThroughFirstSetup` | `(input) -> plan` | Refuses a request with no origin or an unknown entry point; adds `entry_point` when one is named or came from a recorded page. |
| `setupPlan` | `({runtime, known, prerequisites, native, origin, view, lens}) -> plan` | `view: 'state'` gives the run and its next calls; `'full'` adds `install`, the policy, the mission and the lens. |
| `setupInstalls` | `(origin, native) -> {origin, devices_step, harness_setup}` | HTTPS origins get the harness files and commands; any other origin says `not_served`. |

## Dependencies

**Depends on:** `shared-code` (server instruction paragraphs, renamed tools, agent delivery), `keep-and-wake-ai-sessions-on-this-computer` (the harness manifest and server instructions), `set-up-my-devices-and-cameras` (device apps), `set-up-my-account` (site icon, conflicts), `start-from-any-landing-page` (entry points), `see-a-pursuit-through-the-lens` (the lens text), `pick-where-one-piece-of-work-runs-the-device` (the computer placement), `hand-off-jobs-between-agents` (tool runs for computers), `http-client` and `refuse-requests-to-private-addresses` (through agent delivery), and the modules `@noble/hashes` and `uqr`.

**Depended on by:** `tool-rows.json` (the row packs these files), `test/walk-a-new-person-through-first-setup.test.mjs`.
