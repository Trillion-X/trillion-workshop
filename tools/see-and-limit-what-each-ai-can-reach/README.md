# tools/see-and-limit-what-each-ai-can-reach/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `web/src/ai-apps-screen.mjs` | `aiAppsFacts`: the facts of AI apps and keys, every AI app connected to the account and every personal key with what each reaches, how long it may go unused and how many calls a minute it may make, and the pursuits an AI can be given. Moved byte for byte from the web client (`moved-from.json`). |
| `web/src/webhooks-screen.mjs` | The Webhooks section of AI apps and keys: the person's own webhooks, Send a test and Remove, the form that adds one and the headers every signed message carries. |
| `web/src/webhooks-screen.json` | The section's words and the headers' documentation, as DATA. |
| `web/src/mcp-events.mjs` | MCP Events for a chat app connected to Trillion: subscriptions with a callback address and a signing secret, and the signed POST each matching subscription is sent. |
| `web/src/mcp-events.json` | Which events exist, what they carry and which moments make them, as DATA. |
| `web/src/sign-in-lifetimes.mjs` | How long one sign-in may go unused before it stops working, by how it was approved. |
| `web/src/sign-in-lifetimes.json` | The idle days for each way of approving a sign-in, as DATA. |
| `web/src/sign-in-calls.mjs` | How many calls one sign-in makes in a period, counted before anything wakes the person's store. |
| `web/src/sign-in-calls.json` | The tiers, their limits and their periods, as DATA. |
| `web/src/screen-day.mjs` | A day as the account screens' facts say it (Oct 3, 2026), in UTC. |
| `web/test/catalogue-screen-ai-apps.test.mjs` | The catalogue screen's facts for AI apps and keys: reach controls, lifetimes, call rates, pursuits and the Webhooks section. |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
