# tools/ui/show/run-the-screen-an-ai-wrote/

The one page an AI app (Claude, ChatGPT, any MCP Apps host) loads to show the answer of a call through the door. It runs the screen an AI wrote for that answer: one HTML document with any CSS and script, carried in the call's `screen` field. It draws nothing of its own. There are no parts, no list of kinds, and no rule about what an answer looks like. The code decides.

The `screen` field is an argument of `show_a_screen`, a tool the chat app calls directly, beside the door's one tool. Its definition is `show-a-screen.json` here; a computer's row names that file's fields as parts of its engine's door (`/settings/doors/0/show_tools/0/<field>`, `{ workshop_file, pointer }`, tools/start-a-computer), and the engine lists it as one of the door's `show_tools` (the engine's `src/mcp/hosts.rs`). A call of it runs nothing on the engine. The app streams the call's arguments to this page while the AI types them (`ui/notifications/tool-input-partial`), so the screen appears as it is written.

## Files

| File | Purpose |
|------|---------|
| `runner.mjs` | `runScreens(win, { connect, words })`. It holds the code, paints it as it grows (at most once per animation frame, scripts inert), runs its scripts once the input is whole, and gives the code `window.door`. If the call carried no code, it tries the requests the words name in order. |
| `boot.mjs` | The page's start: reads its own words (`#screen-words`) and connects the AI app's bridge (`../ai-app-bridge/ai-app-bridge.mjs`). |
| `show-a-screen.json` | The `show_a_screen` tool as the chat app lists it: its name, title, words, input (`screen`, `answer`, `address`, `method`, `input`) and annotations. A computer row fills its door's `show_tools` entry with these fields, so every computer that offers the tool offers the same words; the row keeps only the entry's `_meta`, the address of its own copy of this page. |
| `make-screen-document.mjs` | `node make-screen-document.mjs <owner-words.json> <out.html>`. It writes the page with the runner and the bridge inside it (about 16 KB), so the page reads nothing from anywhere to start. |
| `test/runner.test.mjs` | The page in real Chromium inside a stand-in MCP Apps host (an opaque-origin frame, as Claude and ChatGPT frame it). |

## What the code is given

`window.door` (or the name the owner's words give as `api_name`), set before any of its scripts run:

| Member | What it is |
|--------|------------|
| `answer` | The call's answer: the `answer` the call itself carried (a show tool's, which runs nothing and carries nothing back, so its result never replaces it), else the result's `structuredContent`. Null until either arrives. |
| `onAnswer(fn)` | `fn` hears the answer now if it is here, and each new one. Answers what stops hearing. |
| `run(method, input)` | The door's one tool, through the app, as the person who connected it, with a fresh 128-bit request key. The call names only its method (`tools:list`); the door finds the owner that answers it. It resolves with the door's answer, or rejects with the door's own words, which are also said above the screen. |
| `tell(text)` | Says `text` in the conversation as the person (MCP Apps `ui/message`, ChatGPT `sendFollowUpMessage`), so the AI hears what was picked or done on the screen and answers. A screen not the person's own shows the words and waits for a press first. |
| `size()` | Tells the app the height the page needs. |

The code may link the look every page of the owner starts with, at the owner's `look.css` (the workspace build writes it), or carry its own.

## The owner's words (`make-screen-document.mjs` input)

The page knows no person, database or tool. The owner's words say:

| Field | What it says |
|-------|--------------|
| `order` | The names of the requests to try, in order, when a call carried no code. |
| `fix_order` | The same, when a screen threw and the person pressed Fix (the error and the code that threw are given). Absent: `order`. |
| `<name>` | One request: `{ method, input, code_at, keep_what_it_wrote? }`. `input` may hold `"{for_operation}"`, `"{answer}"`, `"{error}"`, `"{code}"` strings, each replaced by its value. `code_at` is the JSON Pointer in the answer where the code is, as text or as rows of `{code, made_by}`. |
| `keep` | The request that keeps a screen: given `{id}` (the code's BLAKE3), `{for_operation}`, `{code}` and `{made_by}`. |
| `mine` | The makers whose screens act without asking, such as `ai:chat`. A screen by anyone else asks before each run. |
| `api_name` | The name the code finds its members under. Default `door`. |
| `run_tool` | The door's one tool, which `run` calls. Default `do_one_thing_in_my_account`. |
| `chat_maker` | What a screen the call itself carried is called as a maker. Default `ai:chat`. |
| `asks`, `allow`, `fix`, `not_kept`, `not_found`, `refused`, `tells`, `see_all` | The page's own phrases. |
| `css` | Styles the page carries, such as the owner's look. |
| `fragment_answer` | When the page is opened as a page (an answer's link, outside any app), the name of the address fragment field holding the answer as base64url JSON. It is shown as text, since no request can be made without an app. |

`for_operation` is the call's method and `input.tool` joined by a space. The next answer of the same operation finds the screen kept for it.

## Invariants

- Nothing branches on what an answer, a screen or an operation is. The only choice is whether there is code yet, and then the owner's order.
- A screen acts only as the person, through the door, with the door's own checks.
- A screen someone else made gets a `run` that waits for the person's press: a different function, not a flag the code could change.
- A thrown script shows its words above the screen, with one Fix press.
- A request of the page's own that the app refuses (keeping a screen, reading a kept one) is said above the screen in the app's words; nothing fails silently.
- The page wears the owner's look (the words' `css`) for its own background, text and type, so a screen that sets none still matches.
- The page follows the app's light or dark theme (`color-scheme` from the app's `theme`), so the code's default colors read in either.

## Run the tests

```
node --test tools/ui/show/run-the-screen-an-ai-wrote/test/runner.test.mjs
```

## Replaces

The first answer view of Nov 18 2026 (`tools/ui/show/view-of-a-value`, `src/workspace/value-view.tsx`). Its shape rules drew every answer from 13 named parts. That was a fixed list, which the owner rejected: "CODE ISNT [an enum]. ANY CODE YOU WANT."
