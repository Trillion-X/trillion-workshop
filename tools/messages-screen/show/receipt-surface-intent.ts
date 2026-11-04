// PORTED FROM: bitfield-packages/packages/chat/show/receipt-surface-intent.ts @ e99ac5976
import { declaredSelectorPath } from '../../ui/read-data/declared-selector';
import {
  emitAddressedSurfaceIntentRequest,
  type AddressedSurfaceIntentRequest,
} from '../../ui/show/placeable-surface-intent';

const RECEIPT_SOURCE_INPUT = 'selector-source-by-address-label';

export interface ReceiptSurfaceIntentBinding {
  readonly sourceRef?: unknown;
  readonly selector?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Build the browser-local request from trusted tool-message metadata. The
 * receipt remains Workflow-owned durable truth; this is only an addressed read
 * of that truth into one explicitly active presentation owner.
 */
export function receiptSurfaceIntentRequest(
  binding: ReceiptSurfaceIntentBinding | null | undefined,
  destinationRef: string | null | undefined,
): AddressedSurfaceIntentRequest | null {
  const destination = nonEmptyString(destinationRef);
  const receiptRef = nonEmptyString(binding?.sourceRef);
  const intentPath = declaredSelectorPath(binding?.selector);
  if (!destination || !receiptRef || !intentPath) return null;
  return {
    destinationRef: destination,
    deliveryRef: receiptRef,
    source: {
      input: RECEIPT_SOURCE_INPUT,
      params: { addressLabel: receiptRef },
    },
    intentPath,
    keyPath: ['evidence', 'attempt_ref'],
    // This route is emitted only from an explicit viewer action. Descriptor
    // results without a disposition therefore place instead of adding a second
    // hidden confirmation step inside the recipient.
    defaultRoute: 'emit',
  };
}

export function emitReceiptSurfaceIntent(
  binding: ReceiptSurfaceIntentBinding | null | undefined,
  destinationRef: string | null | undefined,
): boolean {
  const request = receiptSurfaceIntentRequest(binding, destinationRef);
  return request ? emitAddressedSurfaceIntentRequest(request) : false;
}
