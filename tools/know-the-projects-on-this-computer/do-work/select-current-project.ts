import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const SELECT_CURRENT_PROJECT_ACTION = 'action:select-current-project';

export async function selectCurrentProject(value: string | null): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SELECT_CURRENT_PROJECT_ACTION,
      include_steps: false,
      include_output: false,
      input: { value },
    },
  });
}
