// PORTED FROM: bitfield-packages/packages/chat/do-work/refresh-chat-history.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

// One writer for chat-session-window:latest: action:materialize-chat-session-window
// reads every descriptor-named source (CLI transcripts today; live terminals and
// service-connection sources as more descriptor rows) and now publishes the window
// itself (its `publish` write step). The old superconductor-only publish action is
// no longer invoked here — a second writer would clobber the materialized window
// last-writer-wins (the two-window disconnect, see chat observation 2026-06-28).
export const REFRESH_CHAT_HISTORY_ACTION = 'action:materialize-chat-session-window';

export async function refreshChatHistory(): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REFRESH_CHAT_HISTORY_ACTION,
      include_steps: false,
      include_output: false,
      input: {},
    },
  });
}
