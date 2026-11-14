# MVPBlocks chat

Complete WorkingChatbot layout, message stream and input adapted from the pinned
BSD-3-Clause source, not a button substitution inside Expansion's old chat.
`WorkingChatbot`, `MessageStream`, and `ChatInput` are mounted by the shared
controls bridge. Expansion retains transport, context, drafts and media actions.
Appearance belongs to `packages/screen-look/show/mvpblocks-chat.css`.

Removed: demo endpoint, branding, avatars, response timers, unconditional copy
success and character counter. Markdown renders through upstream react-markdown
with raw HTML disabled. Real activity uses AICSS and copy uses Kibo's tested control.

Expansion's former BeautifulUI composer implementation and Coss message renderer
were removed from the consumer. Source archives retain originals for attribution.
The protected video, transcript and captions surfaces are unchanged.
