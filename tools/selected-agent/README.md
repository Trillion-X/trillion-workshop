# tools/selected-agent

Which AI answers a person: `do-work/set-selected-agent.ts` sends the request that keeps their choice (or, with an empty id, sends them back to automatic routing) to the workflow slot, through the workspace's `#workspace-records`. Moved from old trillion's `parts/selected-agent/`; trillion-apps keeps its own byte-identical copy at `web/parts/selected-agent/`, which is what the app's chat screen imports.

## Files

| File | Purpose |
|------|---------|
| `do-work/set-selected-agent.ts` | `setSelectedAgent(agentId, definitionId?)`: the one request that keeps the choice |
| `run/plan-selected-agent.mjs` | `planSelectedAgent({ agent_id, definition_id? })` → `{ request, automatic }`: the request `setSelectedAgent` would send, unsent (what `tool-rows.json` runs) |
| `run/requests-kept-here.mjs` | Stands in for `#workspace-records` in the run: keeps each request instead of sending it |
| `run/package.json` | Maps `#workspace-records` to `requests-kept-here.mjs`, for files laid under `run/` only |
| `tool-rows.json` | The row `tool:choose-which-ai-answers-me`, with a sample run that chooses a sample AI |

## The row

The row lays `do-work/` under `run/` in the run (`/opt/selected-agent/run/do-work/`), so `set-selected-agent.ts` finds `run/package.json` as its nearest package and its `#workspace-records` import reaches the stand-in. In this folder `do-work/` stays outside `run/`, so nothing that imports `set-selected-agent.ts` from here gets the stand-in instead of the workspace's own sender. The row sends nothing and changes no one's choice.
