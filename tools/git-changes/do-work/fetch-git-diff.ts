import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const FETCH_GIT_DIFF_ACTION = 'action:fetch-git-diff';

export async function fetchGitDiff(input: {
  projectId: string;
  filePath: string;
}): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: FETCH_GIT_DIFF_ACTION,
      include_steps: false,
      include_output: true,
      input: {
        project_id: input.projectId,
        file_path: input.filePath,
      },
    },
  });
}
