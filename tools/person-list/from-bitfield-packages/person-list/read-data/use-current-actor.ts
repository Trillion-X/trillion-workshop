// package://packages/group-list/read-data/use-current-actor.ts
//
// Resolves "you" for this screen. Three layers:
//
// 1. Mount props first — `activeActorRef` / `active_actor_ref`, exactly the
//    prop pair the item feed screen reads when the screen host supplies the
//    signed-in person.
// 2. Signed-in account second — the runner exposes the account package's
//    `account-session.browser-session` door as a public target. This hook
//    invokes that door with this package's own transport call (no sibling
//    package source is imported — isolation boundary) and derives
//    `actor:<accountIdHash>` from the reply.
// 3. Local fallback — `actor:local`, the same default the do-work builders
//    already use, so a single local person still owns what they create.
//
// The door read is cached for the page load and bounded by a short timeout,
// so signed-out (or slow) sessions settle on the local actor and the screen
// keeps working.

import { useEffect, useState } from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export const LOCAL_ACTOR_REF = 'actor:local';

const BROWSER_SESSION_TARGET = 'account-session.browser-session';
const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';
const BROWSER_SESSION_TIMEOUT_MS = 1500;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function actorRefFromProps(props: Record<string, unknown>): string | null {
  return readText(props.activeActorRef) ?? readText(props.active_actor_ref);
}

export function actorRefFromAccountId(accountIdHash: unknown): string | null {
  const id = readText(accountIdHash);
  return id ? `actor:${id}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The account package keeps its per-browser id at this storage key. Reading
// the key (never writing it) is a data convention, not a source import — if
// the key is absent there is no session to ask about.
function storedBrowserId(): string | null {
  try {
    return readText(globalThis.localStorage?.getItem(BROWSER_ID_STORAGE_KEY));
  } catch {
    return null;
  }
}

function decodeReply(raw: unknown): unknown {
  const payload = isRecord(raw) && raw.payload instanceof Uint8Array ? raw.payload : raw;
  if (!(payload instanceof Uint8Array)) return payload;
  const text = textDecoder.decode(payload);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// Door reply shape: `{ session: { accountIdHash, ... } | null }`.
export function signedInActorRefFromReply(reply: unknown): string | null {
  const decoded = decodeReply(reply);
  if (!isRecord(decoded) || !isRecord(decoded.session)) return null;
  return actorRefFromAccountId(decoded.session.accountIdHash ?? decoded.session.accountId);
}

async function readSignedInActorRef(): Promise<string | null> {
  const browserId = storedBrowserId();
  if (!browserId) return null;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), BROWSER_SESSION_TIMEOUT_MS);
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: BROWSER_SESSION_TARGET,
      payload: textEncoder.encode(JSON.stringify({ browser_id: browserId })),
    }, controller.signal);
    return signedInActorRefFromReply(reply);
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

// One door read per page load, shared by every component on the screen.
let cachedSignedInActorRef: string | null | undefined;
let pendingSignedInActorRef: Promise<string | null> | null = null;

function resolveSignedInActorRef(): Promise<string | null> {
  if (cachedSignedInActorRef !== undefined) return Promise.resolve(cachedSignedInActorRef);
  pendingSignedInActorRef ??= readSignedInActorRef().then((actorRef) => {
    cachedSignedInActorRef = actorRef;
    pendingSignedInActorRef = null;
    return actorRef;
  });
  return pendingSignedInActorRef;
}

/**
 * Current actor ref for reads and writes on this screen. Mount props win;
 * otherwise the signed-in account (via the public browser-session door);
 * otherwise the local actor. Never returns an empty string.
 */
export function useCurrentActorRef(props: Record<string, unknown>): string {
  const propActorRef = actorRefFromProps(props);
  const [signedInActorRef, setSignedInActorRef] = useState<string | null>(
    () => cachedSignedInActorRef ?? null,
  );
  useEffect(() => {
    if (propActorRef || cachedSignedInActorRef !== undefined) return;
    let cancelled = false;
    void resolveSignedInActorRef().then((actorRef) => {
      if (!cancelled && actorRef) setSignedInActorRef(actorRef);
    });
    return () => {
      cancelled = true;
    };
  }, [propActorRef]);
  return propActorRef ?? signedInActorRef ?? LOCAL_ACTOR_REF;
}
