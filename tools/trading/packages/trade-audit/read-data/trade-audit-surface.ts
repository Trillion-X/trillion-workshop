// package-set://bitfield-studio/packages/trade-audit/read-data/trade-audit-surface.ts

export const tradeAuditSurface = {
  title: 'Order history',
  status: 'quiet',
  summary: 'Every paper order and broker answer is saved here. Secrets never appear.',
  eventKinds: ['drafted', 'risk checked', 'allowed checked', 'paper sent', 'broker answered', 'matched'],
  ownedRecords: ['event', 'payload proof', 'compliance mark', 'related order'],
  operationGraph: [
    ['Save order step', 'add it to order history'],
    ['Save broker answer', 'add the broker answer'],
  ],
  evidenceOutputs: ['order step', 'paper result', 'linked order'],
  invariants: [
    'Secrets stay out.',
    'Every order step is saved.',
    'Broker refresh waits for a connected broker.',
  ],
  reusedPrimitives: ['order steps', 'append-only log', 'redacted proof'],
} as const;
