# tools/walk-a-new-person-through-first-setup/

Walk a new person through first setup: the apps to install on their devices, the AIs to connect, and the saved run that resumes where they stopped. The tool is a projection: the caller reads the saved run, the account's access prerequisites, what the account already has, its computers and the person's pursuit lens from their own records, and hands them over. Nothing here reads storage or the clock, and nothing is written.

Ported from old trillion `src/setup-plan.mjs` and `src/setup-installs.mjs` at tag `old-trillion-before-worker-retire` (b6ae0ebf81). The row is `tool:walk-a-new-person-through-first-setup` in `tool-rows.json`.

## What the old files became

| Old file | Decision | What happened |
|---|---|---|
| `src/setup-plan.mjs` | Ported in part | `setupPlan` and `setupInstructions` are `do-work/setup-plan.mjs`. The policy is `read-data/setup-policy.json` (copied byte for byte from the tag). The lens is handed in as `lens` instead of a module-level `useLens`. `setupTools` (the MCP `start_setup` and `read_setup` surface and its HTTP reads of `/setup/runtime`, `/setup/requirements`, `/pursuits`, `/connections`, `/network/ensure-profile`, `/setup/devices`, `/computer-sources` and `/agents/find`) is not carried: the caller reads those and hands them in, and the Workshop row is the surface. |
| `src/setup-installs.mjs` | Ported | `do-work/setup-installs.mjs`, with its imports pointed at the Workshop folders that now hold the same modules. |
| `src/setup-runtime.mjs` | Moved | `tools/set-up-my-account/from-an-older-version/src/setup-runtime.mjs`, moved wholesale on 2026-11-14: this tool is a projection that reads no storage, and set-up-my-account's `tool:read-setup` is the one read of setup facts, so the runtime reads the setup run there and hands it to the screen (and to this tool's `setupPlan` through its caller). Its test stays held in `from-an-older-version/test/`. |
| `src/setup-policy.json` | Ported | `read-data/setup-policy.json`. |
| `test/setup-plan.test.mjs`, `test/setup-runtime.test.mjs` | Held | Still in `from-an-older-version/test/`. The plan's own behaviour is tested by `test/walk-a-new-person-through-first-setup.test.mjs`. |

## Gap

`start_setup` is the write path that starts or resumes the saved run. Its decision is now `tool:start-or-resume-the-first-setup` (`do-work/start-or-resume-the-first-setup.mjs`): it returns the ordered owner calls, each with a read-back, and writes nothing. The runner that makes those calls is the caller's. The workflow call starts the setup recipe (the shipped recipe whose `default_for` names the policy's purpose, `tools/workflows/read-data/public-recipes.mjs`) as `input.row`, under the policy's `request_key` as the run's request key, so the run it starts is the run `tool:read-setup` reads back. The plan's own words still say `start_setup` and `read_setup` (the old MCP names) until the plan names the Workshop tool ids.

## Files

| File | Purpose |
|------|---------|
| `do-work/walk-a-new-person-through-first-setup.mjs` | `tool:walk-a-new-person-through-first-setup`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `do-work/setup-plan.mjs` | `setupPlan({ runtime, known, prerequisites, native, origin, view, lens })`: the plan. |
| `do-work/setup-installs.mjs` | `setupInstalls(origin, native)`: the device apps step and the harness setup (download, inspect, apply, remove per supported host, MCP registration preview). |
| `read-data/setup-policy.json` | The setup policy (goal, principles, workflow steps). |
| `do-work/choose-toolkit.mjs` | `chooseToolkit({ toolkits, choice, knownTools? })`: a toolkit is a list row of type `record:toolkit` (`{ id, type, value: { title?, description?, tools } }`) listing tool ids; the person picks one, drops some of its tool ids and adds others, and the answer is the tool ids to install. `offeredToolkits(rows)` reads the rows the caller hands in, as `records:list` returns them. `TOOLKITS_READ` is that read (`records:list` of type `record:toolkit` at `@own-records`); the plan carries it as `read_toolkits_call`. |
| `do-work/toolkit-stack.mjs` | The stack a toolkit row carries besides its tools: `value.stack` is `{ slot: [pointer, ...] }`. A pointer is `{ id, door, speaks, label?, credential? }`: the address, the language it speaks, its name at that address, and the NAME of the vault entry that holds its key; the key is never in a row, and a pointer with another field, a credential that is not a name, or a door address with a user, a query or a fragment is refused (`readPointer`, `readStack`). It is DATA read once, never code in the path to the thing: nothing here calls a pointer, orders attempts or swaps (a swap is the person or their AI editing the row). A row with tools only has no stack and reads as before. |
| `read-data/stack-policy.json` | The shapes and limits of a stack (slot, pointer id, door, language, label and credential patterns, most slots, most pointers per slot). No slot, vendor or database is named in it or in the code. |
| `do-work/choose-toolkit.mjs` `fillCart` | The cart first setup fills a new account with: the person's choice or, when nothing is picked, the one offered toolkit marked `default: true`. The plan carries it as `toolkits.cart`. |
| `toolkits/starter-toolkits.json` | The three starter toolkits the Workshop ships, built from the tools of the kits in `tools/workflows/kits/`. `source:starter-toolkits` in `tool-rows.json` lists them the way `source:workflow-recipes` lists recipes, so they travel the road tool rows travel and land in the account's `record:toolkit` list beside the person's own. |
| `swaps/starter-swaps.json` | Starter swaps (type `record:toolkit-swap`): parts a person swaps into any toolkit's cart for another way of setting up (their own domain and sign-in, no domain, a Linux machine they already run). A row's `swap` is handed in as `toolkit_choice.swap` as it stands, so any toolkit with any swap is a cart. `source:starter-toolkit-swaps` lists them. A choice may name a swap row by its id (`swap: "toolkit-swap:..."`), into the named toolkit or the default one. A company's own sign-in (OIDC or SAML) has no swap: the official Better Auth tool runs no single sign-on plugin. |
| `do-work/choose-toolkit.mjs` `STARTER_TOOLKITS`, `STARTER_SWAPS`, `withStarters`, `swapOf` | The starter rows travel with the tool (its package files lay `toolkits/` and `swaps/`), so it reads them itself and asks no store. The person's own toolkit and swap rows are handed in (`toolkits`, `toolkit_swaps`) from wherever they keep them; a row of theirs with a starter's id stands in its place, and their own default makes the starter default stand down. Run as a listed starter row (`invoke_with`), the engine's `row` is the pick. Until Nov 19 2026 the plan named `records:list` at `@own-records` for these rows, a store that no longer answers. |
| `do-work/start-or-resume-the-first-setup.mjs` | `tool:start-or-resume-the-first-setup`: the ordered owner calls for starting or resuming the saved run, each with its read-back. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/start-or-resume-the-first-setup.test.mjs` | Tests for the start or resume plan: fresh, unavailable owners, done steps, stopped, stuck resume, finished and refusals. |
| `test/walk-a-new-person-through-first-setup.test.mjs` | Tests for the plan: state and full views, http and https origins, the lens, the stopped setup, entry points and refusals. |
| `part.json` | The three modules a caller may import. |
| `from-an-older-version/` | The held files not yet ported, with their receipt. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `walkAPersonThroughFirstSetup` | `(input) -> plan` | Refuses a request with no origin or an unknown entry point; adds `entry_point` when one is named or came from a recorded page. |
| `setupPlan` | `({runtime, known, prerequisites, native, origin, view, lens}) -> plan` | `view: 'state'` gives the run and its next calls; `'full'` adds `install`, the policy, the mission and the lens. |
| `chooseToolkit` | `({toolkits, choice, knownTools?}) -> {toolkit, tools, dropped, added}` | Refuses a toolkit that is not offered, a drop the toolkit does not list, an id both dropped and added, and an added id outside `knownTools`. |
| `setupInstalls` | `(origin, native) -> {origin, devices_step, harness_setup}` | HTTPS origins get the harness files and commands; any other origin says `not_served`. |

## Dependencies

**Depends on:** `shared-code` (server instruction paragraphs, renamed tools, agent delivery), `keep-and-wake-ai-sessions-on-this-computer` (the harness manifest and server instructions), `set-up-my-devices-and-cameras` (device apps), `set-up-my-account` (site icon, conflicts), `start-from-any-landing-page` (entry points), `see-a-pursuit-through-the-lens` (the lens text), `pick-where-one-piece-of-work-runs-the-device` (the computer placement), `hand-off-jobs-between-agents` (tool runs for computers), `http-client` and `refuse-requests-to-private-addresses` (through agent delivery), and the modules `@noble/hashes` and `uqr`.

**Depended on by:** `tool-rows.json` (the row packs these files), `test/walk-a-new-person-through-first-setup.test.mjs`.
