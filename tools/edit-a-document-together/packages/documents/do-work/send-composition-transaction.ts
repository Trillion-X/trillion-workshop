import type {
  CompositionSnapshot,
  CompositionTransaction,
} from '../read-data/documents';

const DEFAULT_CAMERA = { pan_x: 0, pan_y: 0, zoom: 1 };
export const COMPOSITION_ENGINE_TARGET = 'slot::composition-engine';
export const COMPOSITION_TRANSACTION_TYPE = 'composition-transaction';
const RUNNING_COMMAND_LIST_BASIS_HEADER = 'X-Bitfield-Running-Command-List-Basis';

let runningCommandListBasisPromise: Promise<string | null> | null = null;

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

// HTTP sender for composition-engine transactions. The browser WS invoke lane
// does not return replies for slot:: targets on the current studio admission
// (composition-engine answers over HTTP but the WS complete-frame is not routed
// back), so the surface's await hangs and "New page" produces nothing. This
// posts the transaction to the shell's /target/<target> route. That route
// requires the running-command-list basis header; the basis comes from the
// /boot catalog (cached per page), with a single 428-body retry as the
// rotation fallback. Same-origin, no SDK dependency. Console logs trace every
// step so failures are visible.
async function httpCompositionSender(
  request: CompositionTransactionRequest,
): Promise<unknown> {
  const url =
    '/target/' +
    request.target
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  const body = JSON.stringify(request.payload);
  // A mutation carries scene_patches; a measure/reflow send carries none. Only
  // trace mutations so the per-frame measure loop never floods the console.
  const firstPatch = request.payload.scene_patches?.[0]?.type ?? '(none)';
  const trace = firstPatch !== '(none)';
  if (trace) console.log('[composition] invoke ->', request.target, 'patch=', firstPatch);
  const runningCommandListBasis = await getRunningCommandListBasis();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(runningCommandListBasis ? { [RUNNING_COMMAND_LIST_BASIS_HEADER]: runningCommandListBasis } : {}),
  };
  let res = await fetch(url, { method: 'POST', headers, body });
  if (res.status === 428) {
    const basis = (await res.clone().json())?.running_command_list_basis;
    if (typeof basis === 'string' && basis.length > 0) {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, [RUNNING_COMMAND_LIST_BASIS_HEADER]: basis },
        body,
      });
    }
  }
  const text = await res.text();
  if (!res.ok) {
    console.error('[composition] FAILED', res.status, text.slice(0, 160));
    throw new Error(`composition-engine HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  if (trace) console.log('[composition] applied', firstPatch, 'ok');
  return text;
}

export async function sendCompositionTransaction(
  transaction: CompositionTransaction,
  sender: CompositionTransactionSender = httpCompositionSender as CompositionTransactionSender,
): Promise<unknown> {
  return sender(buildCompositionTransactionRequest(transaction));
}

export async function decodeCompositionSnapshotReply(reply: unknown): Promise<CompositionSnapshot> {
  const payload = payloadFromReply(await reply);
  const decoded = JSON.parse(payload) as Partial<CompositionSnapshot>;
  return {
    tree: decoded.tree ?? null,
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

async function getRunningCommandListBasis(): Promise<string | null> {
  if (!runningCommandListBasisPromise) {
    runningCommandListBasisPromise = readRunningCommandListBasis();
  }
  return runningCommandListBasisPromise;
}

async function readRunningCommandListBasis(): Promise<string | null> {
  try {
    const response = await fetch('/boot', {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return null;
    const slotConfigs = await response.json();
    if (!Array.isArray(slotConfigs)) return null;
    const basis = slotConfigs[0]?.running_command_list_basis;
    return typeof basis === 'string' && basis.length > 0 ? basis : null;
  } catch {
    return null;
  }
}
