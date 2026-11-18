# tools/ui/show/run-the-screen-an-ai-wrote/

The one page an AI app (Claude, ChatGPT, any MCP Apps host) loads to show the answer of a call through the door. It runs the screen an AI wrote for that answer: one HTML document with any CSS and script, carried in the call's `screen` field. It draws nothing of its own. There are no parts, no list of kinds, and no rule about what an answer looks like. The code decides.

The `screen` field is laid on the door's one tool by the door owner's row (trillion-rust `src/mcp/hosts.rs` `tool_input`), and the door takes it out of the call before running anything. The app streams the call's arguments to this page while the AI types them (`ui/notifications/tool-input-partial`), so the screen appears as it is written.

## Files

| File | Purpose |
|------|---------|
| `runner.mjs` | `runScreens(win, { connect, words })`. It holds the code, paints it as it grows (at most once per animation frame, scripts inert), runs its scripts once the input is whole, and gives the code `window.door`. If the call carried no code, it tries the requests the words name in order. |
| `boot.mjs` | The page's start: reads its own words (`#screen-words`) and connects the AI app's bridge (`../ai-app-bridge/ai-app-bridge.mjs`). |
| `make-screen-document.mjs` | `node make-screen-document.mjs <owner-words.json> <out.html>`. It writes the page with the runner and the bridge inside it (about 16 KB), so the page reads nothing from anywhere to start. |
| `test/runner.test.mjs` | The page in real Chromium inside a stand-in MCP Apps host (an opaque-origin frame, as Claude and ChatGPT frame it). |

## What the code is given

`window.door` (or the name the owner's words give as `api_name`), set before any of its scripts run:

| Member | What it is |
|--------|------------|
| `answer` | The call's answer (`structuredContent`), null until it arrives. |
| `onAnswer(fn)` | `fn` hears the answer now if it is here, and each new one. Answers what stops hearing. |
| `run(address, method, input)` | The door's one tool, through the app, as the person who connected it, with a fresh 128-bit request key. It resolves with the door's answer, or rejects with the door's own words. |
| `size()` | Tells the app the height the page needs. |

The code may link the look every page of the owner starts with, at the owner's `look.css` (the workspace build writes it), or carry its own.

## The owner's words (`make-screen-document.mjs` input)

The page knows no person, database or tool. The owner's words say:

| Field | What it says |
|-------|--------------|
| `order` | The names of the requests to try, in order, when a call carried no code. |
| `fix_order` | The same, when a screen threw and the person pressed Fix (the error and the code that threw are given). Absent: `order`. |
| `<name>` | One request: `{ address, method, input, code_at, keep_what_it_wrote? }`. `input` may hold `"{for_operation}"`, `"{answer}"`, `"{error}"`, `"{code}"` strings, each replaced by its value. `code_at` is the JSON Pointer in the answer where the code is, as text or as rows of `{code, made_by}`. |
| `keep` | The request that keeps a screen: given `{id}` (the code's BLAKE3), `{for_operation}`, `{code}` and `{made_by}`. |
| `mine` | The makers whose screens act without asking, such as `ai:chat`. A screen by anyone else asks before each run. |
| `api_name` | The name the code finds its members under. Default `door`. |
| `chat_maker` | What a screen the call itself carried is called as a maker. Default `ai:chat`. |
| `asks`, `allow`, `fix` | The page's own three phrases. |
| `css` | Styles the page carries, such as the owner's look. |
| `fragment_answer` | When the page is opened as a page (an answer's link, outside any app), the name of the address fragment field holding the answer as base64url JSON. It is shown as text, since no request can be made without an app. |

`for_operation` is the call's address, method and `input.tool` joined by spaces. The next answer of the same operation finds the screen kept for it.

## Invariants

- Nothing branches on what an answer, a screen or an operation is. The only choice is whether there is code yet, and then the owner's order.
- A screen acts only as the person, through the door, with the door's own checks.
- A screen someone else made gets a `run` that waits for the person's press: a different function, not a flag the code could change.
- A thrown script shows its words above the screen, with one Fix press.

## Run the tests

```
node --test tools/ui/show/run-the-screen-an-ai-wrote/test/runner.test.mjs
```

## Replaces

The first answer view of Nov 18 2026 (`tools/ui/show/view-of-a-value`, `src/workspace/value-view.tsx`). Its shape rules drew every answer from 13 named parts. That was a fixed list, which the owner rejected: "CODE ISNT [an enum]. ANY CODE YOU WANT."
