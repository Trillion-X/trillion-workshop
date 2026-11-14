import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const COMMIT_GIT_CHANGES_ACTION = 'action:commit-git-changes';

export async function commitGitChanges(input: {
  projectId: string;
  message: string;
}): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: COMMIT_GIT_CHANGES_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        project_id: input.projectId,
        message: input.message,
      },
    },
  });
}
