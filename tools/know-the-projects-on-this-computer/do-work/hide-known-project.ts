import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const HIDE_KNOWN_PROJECT_ACTION = 'action:hide-known-project';

export async function hideKnownProject(projectId: string): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: HIDE_KNOWN_PROJECT_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        project_id: projectId,
        hidden: true,
      },
    },
  });
}
