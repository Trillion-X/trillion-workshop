import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const TOGGLE_PROJECT_PIN_ACTION = 'action:toggle-project-pin';

export async function pinKnownProject(input: {
  projectId: string;
  pinned: boolean;
}): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: TOGGLE_PROJECT_PIN_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        project_id: input.projectId,
        pinned: input.pinned,
      },
    },
  });
}
