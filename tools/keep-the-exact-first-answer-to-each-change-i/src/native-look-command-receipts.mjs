// Local Look mutations retain their exact original protected response. Public
// publication effects retain their own addressed publication command owner.
import { nativeLocalCommandReceipts } from '../../shared-code/src/native-local-command-receipts.mjs';
export function nativeLookCommandReceipts(supplies) {
  return nativeLocalCommandReceipts({ ...supplies, operations: ['looks:wear', 'looks:save', 'looks:over_time', 'looks:set_rule', 'looks:remove_rule'],
    requestOperations: ['looks:request'], receiptPrefix: 'resource-look-command' });
}
