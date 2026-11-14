import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const UPDATE_SELECTED_TEXT_FOR_NEXT_AGENT_REQUEST_ACTION = 'action:update-selected-text-for-next-agent-request';

interface FileEditorSelectedTextForNextAgentRequest {
  source: 'file';
  identifier: string;
  title: string;
  selectedText: string;
  startLine?: number;
  endLine?: number;
  fullContent?: string;
}

export async function writeFileEditorSelectedTextForNextAgentRequest(
  value: FileEditorSelectedTextForNextAgentRequest | null,
): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UPDATE_SELECTED_TEXT_FOR_NEXT_AGENT_REQUEST_ACTION,
      include_steps: false,
      include_output: false,
      input: { value },
    },
  });
}
