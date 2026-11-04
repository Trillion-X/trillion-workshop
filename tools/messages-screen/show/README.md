# Chat Show

Browser render layer for the Chat package — the surface, its panels, message renderers, composer, and the pure view-model builders that feed them.

## Files

| File | Purpose |
| --- | --- |
| `README.md` | Documents the Chat show folder. |
| `mount-chat.tsx` | React mount entry that wraps `ChatView` in the shared material frame + error boundary. |
| `ChatView.tsx` | Top-level Chat surface (`ParticipantBrowser` is fetched the first time the person opens it): owns session/selection state, the optimistic-annotation fold (`messagesForPanel`), `handleMessageIntent`, and the fail-closed intent dispatch to `submitMessageIntentFromChat`. |
| `ChatPanel.tsx` | Transcript panel; threads the reaction palette, message actions, and `onMessageIntent` down to each message renderer. |
| `ConversationNavigation.tsx` | New chat and searchable conversation selection using the shared CommandPalette; no permanent Chat sidebars. |
| `ChatMessage.tsx` | Single message bubble renderer; composes `MessageAnnotations` for the reaction bar + durable badges on both incoming and outbound bubbles. |
| `MessageAnnotations.tsx` | Generic, palette-driven reaction bar + durable annotation badges; gates tone/visibility on the integer provenance scale (`AUTHORITATIVE=10`), enumerates no symbol. |
| `AgentActivityRenderer.tsx` | Renders live agent-activity turns; composes `MessageAnnotations` so agent turns are annotatable on the same path. A screen an answer carries (`ChatInlinePlaceableSurface`) is fetched the first time an answer carries one. |
| `AgentStatusStrip.tsx` | Compact live agent status strip. |
| `ChatErrorBanner.tsx` | Inline error banner for chat action failures. |
| `ChatFileContent.tsx` | Renders a referenced source file's content inside chat. |
| `ChatFilterPopover.tsx` | Popover for filtering the conversation list. |
| `ChatHeroState.tsx` | Empty/hero state shown when no conversation is selected. |
| `ChatInlinePlaceableSurface.tsx` | Renders an inline placeable surface embedded in a transcript. |
| `ChatInput.tsx` | Message input control (legacy/simple entry path). |
| `ChatInput.test.tsx` | Test for `ChatInput`. |
| `ChatTeammateBar.tsx` | Teammate/participant bar for multi-agent conversations. |
| `EditAcceptReject.tsx` | Accept/reject controls for proposed tool edits. |
| `IdeaModePill.tsx` | Pill toggle for idea-capture mode. |
| `MarkdownContent.tsx` | Markdown renderer for message bodies. |
| `ParticipantBrowser.tsx` | Browser for selecting/adding addressed participants. |
| `PlanSidebar.tsx` | Sidebar showing the parsed plan for a plan-bearing conversation. |
| `PresetButton.tsx` | Single prompt-preset button. |
| `PresetButtonRow.tsx` | Row of prompt-preset buttons. |
| `PresetPopover.tsx` | Popover listing prompt presets. |
| `PresetPopover.test.tsx` | Test for `PresetPopover`. |
| `ToolRendererCode.tsx` | Renders a code tool-use block. |
| `ToolRendererDiff.tsx` | Renders a diff tool-use block. |
| `ToolRendererSearch.tsx` | Renders a search tool-use block. |
| `ToolRendererTerminal.tsx` | Renders a terminal tool-use block. |
| `ToolUseBlock.tsx` | Generic tool-use block wrapper that dispatches to the matching tool renderer. |
| `tool-registry.ts` | Data-owned registry mapping a tool-use kind to its renderer; no renderer enumeration in call sites. |
| `chat-logic.ts` | Pure chat view-model logic shared across panels (selection, ordering, derived state). |
| `chat-send-readiness.ts` | Pure predicate computing whether the composer can send (participant reachable, route/owner target present). |
| `build-agent-status-sessions.ts` | Builds the agent-status strip view model from live session records. |
| `build-chat-conversation-list.ts` | Builds the sidebar conversation list from session-window rows. |
| `participant-mark-spec.ts` | The single mapping from a data-owned participant mark to the shared `ui/` DisplayMark spec; one participant-identity renderer for every chat surface. |
| `participant-badge-color.ts` | Pure deterministic participant → badge color mapping. |
| `plan-parser.ts` | Parses a plan-bearing transcript into structured plan steps for `PlanSidebar`. |
| `resolve-source-session-ref.ts` | Resolves the initial source-session ref for a launched conversation (resume vs fresh). |
| `resolve-source-session-ref.test.ts` | Test for `resolve-source-session-ref`. |
| `shiki-loader.ts` | Lazy loader for the Shiki syntax highlighter used by code renderers. |
| `input/` | Composer subtree (chat composer, send button, slash-command menu, unified agent picker). |
| `__tests__/` | Show-layer proof files (agent status strip, people source items, sources rail, transcript-row dispatch). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `ChatView` | `(props: ChatViewProps) -> JSX.Element` | Root Chat surface; owns optimistic-reaction state, `handleMessageIntent`, and the fail-closed intent dispatch. |
| `handleMessageIntent` | `(intent: MessageIntent) -> void` | Renders the authored annotation optimistically at provenance 0, then dispatches `submitMessageIntentFromChat`; drops the optimistic entry on write failure. |
| `MessageAnnotations` | `(props: { message, reactionPalette, messageActions, onMessageIntent }) -> JSX.Element` | Palette-driven reaction bar + durable badges; renders any DATA-declared symbol/action, gates on integer provenance. |
| `ToolUseBlock` | `(props: { block }) -> JSX.Element` | Dispatches a tool-use block to its registered renderer via `tool-registry`. |
| `computeParticipantSendReadiness` | `(input: ParticipantSendReadinessInput) -> SendReadiness` | Pure composer send-gate predicate. |
| `participantMarkSpec` | `(mark) -> DisplayMarkSpec` | Single participant-identity → DisplayMark mapping reused by every chat surface. |

## Dependencies

**Depends on:** `@/packages/ui`, `@/packages/screen-look`, `@bitfield/runtime-kit/react`, Chat `read-data` decoders/palette reader, and Chat `do-work` commands (`submitMessageIntentFromChat`, exchange/turn writers).

**Depended on by:** the browser Chat package entry (`chat`), Bitfield Studio, a coaching site, and Tribes.
