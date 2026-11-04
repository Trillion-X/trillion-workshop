// Canonical automation mutations use the shared native local outcome owner.
import { nativeLocalCommandReceipts } from '../../shared-code/src/native-local-command-receipts.mjs';
const operations = ['rules:set', 'rules:remove', 'rules:reset', 'rules:run', 'schedules:set', 'schedules:remove', 'schedules:reset', 'schedules:run'];
export function nativeAutomationCommandReceipts(supplies) {
  return nativeLocalCommandReceipts({ ...supplies, operations, requestOperations: ['automations:request'], receiptPrefix: 'resource-automation-command' });
}
