import bugReportRecordsContract from '../things-to-store-and-run.json';

export type BugReportConfiguredAction = 'create-quick-report';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function packageRecords(): readonly Record<string, unknown>[] {
  if (!isRecord(bugReportRecordsContract)) return [];
  const things = bugReportRecordsContract.things;
  if (!Array.isArray(things)) return [];
  return things.filter(isRecord);
}

export function readBugReportConfiguredActionDefinitionId(
  action: BugReportConfiguredAction,
): string {
  for (const thing of packageRecords()) {
    const payload = thing.payload;
    if (!isRecord(payload)) continue;
    if (payload.kind !== 'workflow-action-descriptor') continue;
    if (payload.action_name !== action) continue;
    const definitionId = payload.definition_id;
    if (typeof definitionId === 'string' && definitionId.length > 0) {
      return definitionId;
    }
  }

  throw new Error(`Missing bug-reports configured action: ${action}`);
}
