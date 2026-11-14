import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const UPDATE_AWAY_SUMMARY_LAST_SEEN_ACTION = 'action:update-away-summary-last-seen';

export async function updateAwaySummaryLastSeen(value: string): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UPDATE_AWAY_SUMMARY_LAST_SEEN_ACTION,
      include_steps: false,
      include_output: false,
      input: { value },
    },
  });
}
