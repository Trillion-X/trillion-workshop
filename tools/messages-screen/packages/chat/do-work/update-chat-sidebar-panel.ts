import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { ChatSidebarPanelSettings } from '../read-data/read-chat-sidebar-panel';

const UPDATE_CHAT_SIDEBAR_PANEL_ACTION = 'action:update-chat-sidebar-panel';

export async function updateChatSidebarPanel(next: ChatSidebarPanelSettings): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UPDATE_CHAT_SIDEBAR_PANEL_ACTION,
      include_steps: false,
      include_output: false,
      input: { value: next },
    },
  });
}
