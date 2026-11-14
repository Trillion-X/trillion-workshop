import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export const PUBLISH_CHAT_SESSION_WINDOW_ACTION = 'action:publish-chat-session-window';

export async function publishChatSessionWindow(): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: PUBLISH_CHAT_SESSION_WINDOW_ACTION,
      include_steps: false,
      include_output: false,
      input: {},
    },
  });
}
