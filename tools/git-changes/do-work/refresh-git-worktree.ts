import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const REFRESH_GIT_WORKTREE_ACTION = 'action:refresh-git-worktree';

export async function refreshGitWorktree(projectId: string): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REFRESH_GIT_WORKTREE_ACTION,
      include_steps: false,
      include_output: false,
      input: { project_id: projectId },
    },
  });
}
