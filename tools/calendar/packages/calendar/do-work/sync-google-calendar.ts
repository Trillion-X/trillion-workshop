import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export const GOOGLE_CALENDAR_SYNC_ACTION = 'action:calendar.sync-google-events';

export type GoogleCalendarSyncInput = {
  connectionId?: string;
  rangeStart?: string;
  rangeEnd?: string;
  maxResults?: number;
};

export type GoogleCalendarSyncRequest = {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: typeof GOOGLE_CALENDAR_SYNC_ACTION;
    include_steps: false;
    include_output: false;
    input: {
      connection_id?: string;
      range_start?: string;
      range_end?: string;
      max_results?: number;
    };
  };
};

export function buildGoogleCalendarSyncRequest(input: GoogleCalendarSyncInput = {}): GoogleCalendarSyncRequest {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: GOOGLE_CALENDAR_SYNC_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        connection_id: input.connectionId,
        range_start: input.rangeStart,
        range_end: input.rangeEnd,
        max_results: input.maxResults,
      },
    },
  };
}

export async function requestGoogleCalendarSync(input: GoogleCalendarSyncInput = {}): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildGoogleCalendarSyncRequest(input));
}
