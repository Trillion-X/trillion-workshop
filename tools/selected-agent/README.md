# tools/selected-agent

Which AI answers a person: `do-work/set-selected-agent.ts` sends the request that keeps their choice (or, with an empty id, sends them back to automatic routing) to the workflow slot, through the workspace's `#workspace-records`. Moved from old trillion's `tools/selected-agent/`; trillion-apps keeps its own byte-identical copy at `tools/selected-agent/`, which is what the app's chat screen imports.

## Files

| File | Purpose |
|------|---------|
| `do-work/set-selected-agent.ts` | `setSelectedAgent(agentId, definitionId?)`: the one request that keeps the choice. Still sends to the retired slot; the screen's owner repoints it (open) |
| `packages/selected-agent/` | The selection screen, which imports `do-work/set-selected-agent.ts` |
| `moved-from.json`, `part.json`, `README.md` | Provenance and this file |

## The choice

The person's choice of AI is a row in the person's own store, kept by the recipe `workflow:choose-which-ai-answers-me` (landed by lane w33-3 as its recipe and kit; the recipe is the one this folder's tool row described). One row holds a text id, or the empty choice for automatic routing; a choice that is not text is refused in words; a read with no choice kept gives automatic.

## Removed (lane w33-3b)

The run harness (`run/`: `plan-selected-agent.mjs`, `requests-kept-here.mjs`, `package.json`), the tool row (`what-this-tool-does-and-how-to-run-it.json`, `tool:choose-which-ai-answers-me`) and its kit (`kits/choose-which-ai-answers-me.json`, now `tools/workflows/kits/choose-which-ai-answers-me.json`). What they did: `planSelectedAgent` built the request that keeps the choice, unsent, and a stand-in for `#workspace-records` kept each request in a run. The choice is kept by the recipe above, so the request has no store to build for.
