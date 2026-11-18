// package://packages/item-record/do-work/refresh-item-records.ts
//
// Asks the package-owned refresh definition to republish the addressed
// item feed from current facts so the screen sees newly written posts.

const REFRESH_ITEM_RECORDS_DEFINITION = 'action:item-record.refresh-item-records';

export async function refreshItemRecords(): Promise<{ target: string; payload: unknown }> {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REFRESH_ITEM_RECORDS_DEFINITION,
      include_steps: false,
      include_output: false,
      input: {},
    },
  };
}
