import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const STAGE_GIT_FILES_ACTION = 'action:stage-git-files';

export async function stageGitFiles(input: {
  projectId: string;
  paths: string[];
}): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: STAGE_GIT_FILES_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        project_id: input.projectId,
        paths: input.paths,
      },
    },
  });
}
