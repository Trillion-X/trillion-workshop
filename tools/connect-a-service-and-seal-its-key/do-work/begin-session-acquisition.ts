// packages/service-connections/do-work/begin-session-acquisition.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Start a SESSION-BACKED interactive acquire: launch the acquire descriptor's
// process via `compute.process_session` (NOT the blocking `compute.process`
// workflow ask) and hand back the session's live event-feed address. The
// surface subscribes that address (`liveProcessSessionEventFeeds`, the terminal
// precedent), folds it through `readAcquireChallengeFeed`, and the dialog
// renders the mid-run challenge (WhatsApp pairing code / QR / device code)
// while the process is still waiting for the user.
//
// WHY (Codex-converged, plan §9): a bounded compute.process returns stdout only
// at COMPLETION, but an interactive acquire must show its code MID-RUN while it
// blocks — the resolve-then-show deadlock. Baileys pairing is socket-live-state
// (no split-phase). The process-session event feed is the platform's sanctioned
// live-stdout channel; no new engine code, no child write-batch.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. DATA-selected: a descriptor opts in with `acquire.session: true` — the
//    presence of DATA, not a vendor name or flow enum (L090).// 2. Reuse only: the session target is resolved via the SAME
//    readConfiguredProcessSessionTarget seam terminal uses; the launch payload
//    is the descriptor's own process argv/env (Society DATA).
// 3. NO secrets here: credential materialization stays with the process's own
//    vault-blob contract; this module never sees a token.
// 4. The event-feed address comes from the session's canonical start snapshot
//    (`event_feed_address`) — never constructed by hand.
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import serviceConnectionsContract from '@/packages/service-connections/things-to-store-and-run.json';
import {
  readConfiguredProcessSessionTarget,
  renderProcessSessionLaunchDescriptor,
  type ProcessInputMount,
  type ProcessSessionSettings,
} from '../../process-session/read-data/read-process-session-launch';

export interface SessionAcquireStart {
  sessionId: string;
  eventFeedAddress: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface SessionReplyEnvelope {
  payload?: Uint8Array;
}

function decodeReply(reply: unknown): Record<string, unknown> {
  if (!reply || typeof reply !== 'object') return {};
  const payload = (reply as SessionReplyEnvelope).payload;
  if (!(payload instanceof Uint8Array)) return {};
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** True when the acquire descriptor declares a session-backed (mid-run
 *  challenge) flow — pure DATA presence, no vendor/flow enum (L090). */
export function isSessionAcquire(acquire: unknown): boolean {
  return !!acquire && typeof acquire === 'object'
    && (acquire as Record<string, unknown>).session === true;
}

/**
 * Resolve the descriptor's argv, substituting `{ "field": "<id>" }` entries
 * with the user-collected NON-secret field values (the WhatsApp pairing phone,
 * an account handle, …). The argv row DESCRIBES which collected value it wants
 * (L090) — this resolver never knows any field name. A referenced-but-missing
 * field fails closed with the field id so the dialog can say what to fill in.
 */
function resolveArgv(
  argv: unknown,
  fields: Record<string, string>,
): string[] {
  if (!Array.isArray(argv)) {
    throw new Error('This service is not set up for one-click connect.');
  }
  return argv.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const ref = asString((entry as Record<string, unknown>).field);
      if (ref) {
        const value = fields[ref]?.trim();
        if (!value) throw new Error(`Fill in ${ref} first.`);
        return value;
      }
    }
    throw new Error('This service is not set up for one-click connect.');
  });
}

/**
 * Launch the acquire descriptor's process as a live session and return the
 * session id + its event-feed address. `fields` carries the dialog's collected
 * NON-secret inputs for argv `{field}` substitution. `send` is injected for
 * tests (defaults to the real target dispatch).
 */
export async function beginSessionAcquisition(
  acquire: Record<string, unknown>,
  fields: Record<string, string> = {},
  send: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> = defaultSend,
): Promise<SessionAcquireStart> {
  const process = acquire.process;
  if (!process || typeof process !== 'object') {
    throw new Error('This service is not set up for one-click connect.');
  }
  const descriptor = process as Record<string, unknown>;
  const env = descriptor.env && typeof descriptor.env === 'object' && !Array.isArray(descriptor.env)
    ? Object.entries(descriptor.env as Record<string, unknown>).map(([name, value]) => {
        if (typeof value !== 'string') throw new Error('Connect-session env values must be strings.');
        return { kind: 'literal' as const, name, value, inert: true as const };
      })
    : [];
  const grid = descriptor.session_settings && typeof descriptor.session_settings === 'object'
    ? (descriptor.session_settings as Record<string, unknown>).text_grid
    : null;
  const sessionSettings: ProcessSessionSettings = grid && typeof grid === 'object'
    ? {
        text_grid: {
          columns: Number((grid as Record<string, unknown>).columns),
          rows: Number((grid as Record<string, unknown>).rows),
        },
      }
    : { text_grid: null };
  const containment = descriptor.containment && typeof descriptor.containment === 'object'
    ? descriptor.containment as Record<string, unknown>
    : null;
  const containmentKind = containment?.kind === 'leaf'
    ? 'leaf' as const
    : 'descendant_effect_contained' as const;
  const reply = await send({
    operation: 'start_session',
    descriptor: renderProcessSessionLaunchDescriptor({
      argv: resolveArgv(descriptor.argv, fields),
      ...(typeof descriptor.cwd === 'string'
        ? { cwd: { kind: 'literal' as const, value: descriptor.cwd, inert: true as const } }
        : {}),
      env,
      timeoutMs: typeof descriptor.timeout_ms === 'number' ? descriptor.timeout_ms : 300_000,
      terminationGraceMs: typeof descriptor.termination_grace_ms === 'number'
        ? descriptor.termination_grace_ms
        : 1_000,
      containmentKind,
      pipeEofTimeoutMs: containment
        ? Number(containment.pipe_eof_timeout_ms ?? 1_000)
        : 1_000,
      inputs: Array.isArray(descriptor.inputs) ? descriptor.inputs as ProcessInputMount[] : [],
      sessionSettings,
    }),
  });
  if (reply.result !== 'session_started') {
    throw new Error(asString(reply.reason) ?? 'Could not start the connect session.');
  }
  const sessionId = asString(reply.session_id);
  const snapshot = reply.snapshot && typeof reply.snapshot === 'object'
    ? reply.snapshot as Record<string, unknown>
    : {};
  const eventFeedAddress = asString(snapshot.event_feed_address);
  if (!sessionId || !eventFeedAddress) {
    throw new Error('The connect session returned no live feed to watch.');
  }
  return { sessionId, eventFeedAddress };
}

async function defaultSend(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = readConfiguredProcessSessionTarget(serviceConnectionsContract, 'process-session');
  const reply = await sendRequestToBitfieldTarget({ target, payload });
  return decodeReply(reply);
}
