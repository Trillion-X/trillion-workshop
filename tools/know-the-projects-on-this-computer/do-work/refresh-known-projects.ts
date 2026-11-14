import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const REFRESH_KNOWN_PROJECTS_ACTION = 'action:refresh-known-projects';

export interface RefreshKnownProjectsInput {
  roots?: string[];
}

export async function refreshKnownProjects(input: RefreshKnownProjectsInput = {}): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REFRESH_KNOWN_PROJECTS_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        roots: input.roots ?? [],
        config_json: JSON.stringify({
          roots: input.roots ?? [],
          paths: [],
        }),
      },
    },
  });
}
