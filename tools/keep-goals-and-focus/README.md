# keep-goals-and-focus

A person's goals and what the app is focused on. The Home screen that kept goals, marked the one needle mover and greeted the person is not in this folder (it ran in the app); what is here is its words and the reader that orders goals under the goals they serve.

## Files

| File | Purpose |
|------|---------|
| `home-words.json` | Every word the Home screen showed: greetings, the needle-mover card, the workstreams card, the add-a-goal form, the summary tiles (DATA; nothing here reads it yet) |
| `read-data/pursuit-hierarchy-view.mjs` | Moved from Trillion `src/pursuit-hierarchy-view.mjs` (`moved-from.json`): goals ordered by parent, one row per goal, missing links and cycles kept |
| `read-data/order-goals.mjs` | `orderGoals({ goals })`: the order as one run, with each row's depth and the goal it is shown under (what `tool-rows.json` runs) |
| `moved-from.json` | Where `pursuit-hierarchy-view.mjs` came from and the identity of its bytes |
| `tool-rows.json` | The row `tool:order-my-goals-under-the-goals-they-serve`, with a sample run that shows two goals under the one they serve |
| `README.md` | This file |
