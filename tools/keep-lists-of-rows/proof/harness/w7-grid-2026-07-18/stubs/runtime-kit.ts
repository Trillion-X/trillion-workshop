// Offline harness stub for '@bitfield/runtime-kit' (and /protocol): the REAL
// surface imports the live transport; in the render harness every dispatch is
// answered locally so derived cells resolve deterministically without an
// engine. Formula-shaped requests get an arithmetic echo; everything else
// stays pending/erroring per the surface's honest states.
export async function sendRequestToBitfieldTarget(request: { target: string; payload?: unknown }): Promise<{ payload: Uint8Array }> {
  const p = (request.payload ?? {}) as Record<string, unknown>;
  const context = (p.context ?? {}) as Record<string, unknown>;
  let reply: unknown = { result: null };
  if (request.target === 'slot::formula-engine') {
    const values = Object.values(context).filter((v): v is number => typeof v === 'number');
    // Deterministic stand-in for the fixture's quantity × unit-cost binding;
    // other arities sum so the harness remains target-blind.
    const result = values.length === 2 ? values[0] * values[1] : values.reduce((a, b) => a + b, 0);
    reply = { result };
  } else if (String(request.target).includes('relationship-graph')) {
    reply = { edges: [] };
  } else {
    throw new Error('offline harness: AI unavailable');
  }
  return { payload: new TextEncoder().encode(JSON.stringify(reply)) };
}

export function buildEngineWriteBatchRequestFromLabels(entries: unknown[]): { target: string; payload: unknown } {
  return { target: 'engine.operation.write-batch', payload: { entries } };
}
export function makeAddressFromLabel(): string {
  return `1f20${'0'.repeat(64)}`;
}
export type EngineWriteLabelEntry = {
  partitionLabel: string;
  addressLabel?: string;
  addressMultihashHex?: string;
  pathLabels?: readonly string[];
  payload?: unknown;
  expectedCurrent?: { payloadHashBase64?: string } | null;
};
