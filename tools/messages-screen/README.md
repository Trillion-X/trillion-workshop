# messages-screen

The Messages screen: every conversation with AIs and in spaces, drawn with the shared chat part and its composer. The screen itself (`show/*.tsx`) runs in the app; this folder's row runs the screen's conversation list without it.

## Files

| File | Purpose |
|------|---------|
| `show/build-chat-conversation-list.ts` | The list helpers the screen's sidebar uses: newest first, filter by words, participant or project, group by date |
| `show/list-conversations.mjs` | `listConversations({ conversations, search, participant, project })`: the list as one run (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:list-my-conversations-newest-first`, with a sample run that finds one conversation by a word of its title |
| `README.md` | This file |

The other folders (`chat/`, `conversations/`, `do-work/`, `read-data/`, `show/`) are the screen's code as it was moved here in a9ee258; `show/README.md` describes the chat part.
