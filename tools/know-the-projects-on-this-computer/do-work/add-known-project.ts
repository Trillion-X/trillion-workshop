import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const ADD_KNOWN_PROJECT_ACTION = 'action:add-known-project';

export async function addKnownProject(path: string): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ADD_KNOWN_PROJECT_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        path,
        config_json: JSON.stringify({
          roots: [],
          paths: [path],
        }),
      },
    },
  });
}
