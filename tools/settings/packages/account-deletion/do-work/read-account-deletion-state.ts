// packages/account-deletion/do-work/read-account-deletion-state.ts
//
// Portal deletion-state reader: browser session -> signed effect list ->
// the newest deletion lifecycle event decides whether a request is pending.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  currentBrowserSessionAccessKey,
  currentPresenterBrowserSessionId,
} from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';

const BROWSER_SESSION_TARGET = 'account-session.browser-session';
const EFFECT_LIST_TARGET = 'signed-event-authority.list-effects';

export interface AccountDeletionState {
  accountId: string;
  deletionRequestedAt: string | null;
}

function readJsonReply<T>(payload: Uint8Array): T {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readBrowserSessionAccountId() {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: BROWSER_SESSION_TARGET,
      payload: {
        browser_id: currentPresenterBrowserSessionId(),
        session_access_key: currentBrowserSessionAccessKey(),
      },
    });
    const body = readJsonReply<{ session?: unknown }>(reply.payload);
    const session = isRecord(body.session) ? body.session : null;
    return readString(session?.accountId);
  } catch {
    return null;
  }
}

export type DeletionEffect = { kind?: unknown; material?: Record<string, unknown> };

function readEffectTime(effect: DeletionEffect) {
  const material = isRecord(effect.material) ? effect.material : {};
  return readString(material.occurred_at)
    ?? readString(material.cancelled_at)
    ?? readString(material.requested_at)
    ?? readString(material.created_at)
    ?? '';
}

export function readDeletionRequestedAt(effects: readonly DeletionEffect[]): string | null {
  const deletion = effects.filter((effect) => {
    const material = isRecord(effect.material) ? effect.material : {};
    const eventType = readString(material.event_type) ?? readString(material.lifecycle_state);
    return eventType === 'deletion_requested'
      || eventType === 'deletion_cancelled'
      || readString(effect.kind) === 'account_deletion'
      || readString(effect.kind) === 'account.deletion';
  }).reduce<DeletionEffect | null>((selected, effect) => {
    if (!selected) return effect;
    return readEffectTime(effect) >= readEffectTime(selected) ? effect : selected;
  }, null);
  const material = isRecord(deletion?.material) ? deletion.material : {};
  const eventType = readString(material.event_type) ?? readString(material.lifecycle_state);
  if (eventType === 'deletion_cancelled') return null;
  return readString(material.occurred_at)
    ?? readString(material.requested_at)
    ?? readString(material.created_at);
}

export async function readAccountDeletionState(): Promise<AccountDeletionState | null> {
  const accountId = await readBrowserSessionAccountId();
  if (!accountId) return null;
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: EFFECT_LIST_TARGET,
      payload: { subject: accountId },
    });
    const body = readJsonReply<{ effects?: DeletionEffect[] }>(reply.payload);
    return { accountId, deletionRequestedAt: readDeletionRequestedAt(body.effects ?? []) };
  } catch {
    return { accountId, deletionRequestedAt: null };
  }
}
