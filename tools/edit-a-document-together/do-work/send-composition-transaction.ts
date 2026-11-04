import type {
  CompositionSnapshot,
  CompositionTransaction,
} from '../read-data/documents';
import { sendRequestToBitfieldTarget } from '#workspace-records';

const DEFAULT_CAMERA = { pan_x: 0, pan_y: 0, zoom: 1 };
export const COMPOSITION_ENGINE_TARGET = 'slot::composition-engine';
export const COMPOSITION_TRANSACTION_TYPE = 'composition-transaction';

export type CompositionTransactionRequest = {
  target: typeof COMPOSITION_ENGINE_TARGET;
  payload: CompositionTransaction & {
    type: typeof COMPOSITION_TRANSACTION_TYPE;
  };
};

export type CompositionTransactionSender = (request: CompositionTransactionRequest) => Promise<unknown>;

export function buildCompositionTransactionRequest(
  transaction: CompositionTransaction,
): CompositionTransactionRequest {
  return {
    target: COMPOSITION_ENGINE_TARGET,
    payload: {
      ...transaction,
      type: COMPOSITION_TRANSACTION_TYPE,
    },
  };
}

export async function sendCompositionTransaction(
  transaction: CompositionTransaction,
  sender: CompositionTransactionSender = sendRequestToBitfieldTarget as CompositionTransactionSender,
): Promise<unknown> {
  return sender(buildCompositionTransactionRequest(transaction));
}

export async function decodeCompositionSnapshotReply(reply: unknown): Promise<CompositionSnapshot> {
  const payload = payloadFromReply(await reply);
  const decoded = JSON.parse(payload) as Partial<CompositionSnapshot>;
  return {
    tree: decoded.tree ?? null,
    ...(decoded.authored_tree ? { authored_tree: decoded.authored_tree } : {}),
    frames: decoded.frames ?? {},
    camera: decoded.camera ?? DEFAULT_CAMERA,
    visible_edge_routes: decoded.visible_edge_routes ?? [],
  };
}

function payloadFromReply(reply: unknown): string {
  if (typeof reply === 'string') return reply;
  if (ArrayBuffer.isView(reply)) return new TextDecoder().decode(reply);
  if (reply instanceof ArrayBuffer) return new TextDecoder().decode(reply);
  if (isRecord(reply)) {
    const payload = reply.payload;
    if (typeof payload === 'string') return payload;
    if (ArrayBuffer.isView(payload)) return new TextDecoder().decode(payload);
    if (payload instanceof ArrayBuffer) return new TextDecoder().decode(payload);
  }
  throw new Error('Composition snapshot reply did not include a decodable payload');
}

function isRecord(value: unknown): value is { payload?: unknown } {
  return typeof value === 'object' && value !== null;
}
