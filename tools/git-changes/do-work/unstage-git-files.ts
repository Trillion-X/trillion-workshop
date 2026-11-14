import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const UNSTAGE_GIT_FILES_ACTION = 'action:unstage-git-files';

export async function unstageGitFiles(input: {
  projectId: string;
  paths: string[];
}): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UNSTAGE_GIT_FILES_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        project_id: input.projectId,
        paths: input.paths,
      },
    },
  });
}
