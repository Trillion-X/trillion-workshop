// Configuration settings use the existing local result owner. Shared link/offer
// authorization remains with its actual grant source, independently of capture.
import { nativeLocalCommandReceipts } from '../../shared-code/src/native-local-command-receipts.mjs';
export function nativeConfigurationCommandReceipts(supplies) {
  return nativeLocalCommandReceipts({ ...supplies, operations: ['configurations:save', 'configurations:remove'],
    requestOperations: ['configurations:request'], receiptPrefix: 'resource-configuration-command',
    requestBody: (result, { operation }) => operation === 'configurations:save' ? { configuration: result } : result,
    requestValue: (result, { operation }) => operation === 'configurations:save' ? result.configuration : result });
}
