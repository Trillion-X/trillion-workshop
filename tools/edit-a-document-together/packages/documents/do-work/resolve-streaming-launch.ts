// packages/documents/do-work/resolve-streaming-launch.ts
//
// Resolve the selected agent's LIVE-SESSION launch from DATA, so the composer can
// fire a browser-direct `start_session` (the workflow ask-step → compute.process_session
// path never spawns the CLI). SELECTION is the AI-substrate's concern, so it is
// resolved here from DATA descriptors on the shortcut's dispatch — this package
// names no agent, no cli, no registry address. process-session stays a BLIND
// generic substrate: it only renders the chat_launch (renderLaunchFromChatLaunch)
// and fires it (startProcessSession); it never reads selected-agent / cli_registry.
//
// The `streaming_launch` DATA (dispatch.streaming_launch) declares TWO asks:
//   current: { ask_target, ask_payload, value_path, parse } — reads the selected
//            agent id (same find-current-items ask the config-current rail uses).
//   launch:  { ask_target, ask_payload_template, value_path, parse } — reads that
//            agent's chat_launch; ask_payload_template binds `{agent.id}` via the
//            SAME shared binding resolver the action rail uses.
// Absent DATA, no selection, no chat_launch, or a non-process_session launch all
// resolve to null → the caller uses its existing one-shot workflow dispatch.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { resolveBindingTemplate } from '../../../../ui/show/action-affordance';
import {
  renderLaunchFromChatLaunch,
  type RenderedLaunch,
  type LaunchContext,
} from '../../../../process-session/read-data/render-launch-from-chat-launch';

export type StreamingLaunchSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathGet(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      const idx = Number(part);
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Decode a bitfield reply envelope (`{ payload: bytes | string | value }`) to a
 *  JS value. Realm-safe (ArrayBuffer.isView), tolerant of a plain value. */
function decodeReplyBody(reply: unknown): unknown {
  const payload = isRecord(reply) ? (reply as { payload?: unknown }).payload : undefined;
  if (ArrayBuffer.isView(payload)) {
    const v = payload as ArrayBufferView;
    try { return JSON.parse(new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))); }
    catch { return undefined; }
  }
  if (typeof payload === 'string') { try { return JSON.parse(payload); } catch { return payload; } }
  return payload !== undefined ? payload : reply;
}

/** Run one DATA-declared ask and read `value_path` (optionally JSON-parsing it). */
async function runAsk(ask: Record<string, unknown>, payload: unknown, sender: StreamingLaunchSender): Promise<unknown> {
  const target = typeof ask.ask_target === 'string' ? ask.ask_target : null;
  if (!target || payload === undefined) return undefined;
  let body: unknown;
  try { body = decodeReplyBody(await sender({ target, payload })); }
  catch { return undefined; }
  const valuePath = typeof ask.value_path === 'string' ? ask.value_path : 'items.0.value_json';
  let value = pathGet(body, valuePath);
  // The value may arrive already-structured (a `type:json` fact returns its
  // value_json as an OBJECT, not a JSON string) — parse only a raw string.
  if (ask.parse === 'json' && typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* raw value stands */ }
  }
  return value;
}

/**
 * Resolve the selected agent's process_session launch, rendered against `ctx`
 * (`{prompt, model?, …}`), or null when there is no streaming launch to fire.
 */
export async function resolveStreamingLaunch(
  streamingLaunch: unknown,
  ctx: LaunchContext,
  sender: StreamingLaunchSender = sendRequestToBitfieldTarget as StreamingLaunchSender,
): Promise<RenderedLaunch | null> {
  if (!isRecord(streamingLaunch)) return null;
  const currentAsk = isRecord(streamingLaunch.current) ? streamingLaunch.current : null;
  const launchAsk = isRecord(streamingLaunch.launch) ? streamingLaunch.launch : null;
  if (!currentAsk || !launchAsk) return null;

  const agentId = await runAsk(currentAsk, currentAsk.ask_payload, sender);
  if (typeof agentId !== 'string' || agentId.length === 0) return null;

  // The launch ask's payload binds `{agent.id}` via the shared resolver.
  const launchPayload = launchAsk.ask_payload_template !== undefined
    ? resolveBindingTemplate(launchAsk.ask_payload_template, { agent: { id: agentId } } as never)
    : launchAsk.ask_payload;
  const chatLaunch = await runAsk(launchAsk, launchPayload, sender);

  return renderLaunchFromChatLaunch(chatLaunch, ctx);
}
