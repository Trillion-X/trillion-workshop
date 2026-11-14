// PORTED FROM: bitfield-packages/packages/chat/show/receipt-surface-intent.test.ts @ e99ac5976
import { describe, expect, it } from 'vitest';

import {
  emitReceiptSurfaceIntent,
  receiptSurfaceIntentRequest,
} from './receipt-surface-intent';

const binding = {
  sourceRef: 'package::chat::workflow-execution-receipt::opaque-attempt',
  selector: '$.output.surface',
};

describe('receipt surface intent', () => {
  it('binds one durable receipt and its declared selector to one opaque destination', () => {
    expect(receiptSurfaceIntentRequest(binding, 'workspace:opaque')).toEqual({
      destinationRef: 'workspace:opaque',
      deliveryRef: binding.sourceRef,
      source: {
        input: 'selector-source-by-address-label',
        params: { addressLabel: binding.sourceRef },
      },
      intentPath: ['output', 'surface'],
      keyPath: ['evidence', 'attempt_ref'],
      defaultRoute: 'emit',
    });
  });

  it('fails closed without a receipt, destination, or valid owner-declared selector', () => {
    expect(receiptSurfaceIntentRequest({ ...binding, sourceRef: '' }, 'workspace:opaque')).toBeNull();
    expect(receiptSurfaceIntentRequest(binding, '')).toBeNull();
    expect(receiptSurfaceIntentRequest({ ...binding, selector: '$..surface' }, 'workspace:opaque')).toBeNull();
  });

  it('reports unaccepted delivery when no matching recipient is mounted', () => {
    expect(emitReceiptSurfaceIntent(binding, 'workspace:absent')).toBe(false);
  });
});
