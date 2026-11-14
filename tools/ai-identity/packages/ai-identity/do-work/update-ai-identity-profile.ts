import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export const UPDATE_AI_IDENTITY_PROFILE_ACTION = 'action:update-ai-identity-profile';

export interface UpdateAiIdentityProfileInput {
  name: string;
  persona: string;
}

export async function updateAiIdentityProfile(input: UpdateAiIdentityProfileInput): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UPDATE_AI_IDENTITY_PROFILE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
