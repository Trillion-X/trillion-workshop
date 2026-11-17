import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readBugReportConfiguredActionDefinitionId } from './read-bug-report-configured-action';

export const CREATE_QUICK_BUG_REPORT_ACTION =
  readBugReportConfiguredActionDefinitionId('create-quick-report');

export interface CreateQuickBugReportInput {
  report_id: string;
  title: string;
  description: string;
  steps_to_reproduce: string;
  severity: string;
  reported_at: string;
}

export async function createQuickBugReport(input: CreateQuickBugReportInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: CREATE_QUICK_BUG_REPORT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
