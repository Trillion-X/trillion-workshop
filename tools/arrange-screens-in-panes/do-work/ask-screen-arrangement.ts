import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { LayoutState } from '../read-data/layout-types';
import type { ArrangementConstraints } from '../read-data/arrangement-constraints';

export interface ScreenArrangementRequest {
  state: LayoutState;
  operation: string;
  payload?: unknown;
  viewport?: { w: number; h: number };
  /** The size each tiled pane was drawn at, in layout pixels, by container id.
   * A pane the operation adds takes its neighbour's size and pushes the others over. */
  paneSizes?: Record<string, { w: number; h: number }>;
  /** Presentation policy from show-rules; the Rust slot owns enforcement. */
  constraints?: ArrangementConstraints;
}

export interface ScreenArrangementReply {
  state: LayoutState;
  publication?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeReply(raw: unknown): ScreenArrangementReply {
  const payload = isRecord(raw) && raw.payload instanceof Uint8Array ? raw.payload : raw;
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(payload)) as ScreenArrangementReply;
  }
  if (typeof payload === 'string') {
    return JSON.parse(payload) as ScreenArrangementReply;
  }
  if (isRecord(payload) && isRecord(payload.state)) {
    return payload as unknown as ScreenArrangementReply;
  }
  throw new Error('Invalid screen-arrangement reply');
}

function missingSlotAliasMessage(error: unknown, target: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`unknown target: ${target}`)
    || message.includes('current target not found');
}

async function sendScreenArrangementRequest(request: ScreenArrangementRequest): Promise<unknown> {
  try {
    return await sendRequestToBitfieldTarget({
      target: 'slot::screen-arrangement',
      payload: request,
    });
  } catch (error) {
    if (!missingSlotAliasMessage(error, 'slot::screen-arrangement')) {
      throw error;
    }

    return await sendRequestToBitfieldTarget({
      target: 'screen-arrangement',
      payload: request,
    });
  }
}

export async function askScreenArrangement(request: ScreenArrangementRequest): Promise<ScreenArrangementReply> {
  const reply = await sendScreenArrangementRequest(request);
  return decodeReply(reply);
}
