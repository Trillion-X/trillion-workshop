import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { refreshChatHistory } from './refresh-chat-history';

const RENAME_CHAT_CONVERSATION_ACTION = 'action:rename-chat-session';

export async function renameChatConversation(input: {
  sessionId: string;
  title: string;
}): Promise<unknown> {

  const renameResult = await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RENAME_CHAT_CONVERSATION_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        session_id: input.sessionId,
        title: input.title,
      },
    },
  });
  await refreshChatHistory();
  return renameResult;
}
