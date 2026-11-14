// packages/plan-lifecycle/do-work/read-portal-plan-state.ts
//
// Portal plan reader: browser session -> signed effect list -> plan projection.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const BROWSER_SESSION_TARGET = 'account-session.browser-session';
const EFFECT_LIST_TARGET = 'signed-event-authority.list-effects';
const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';

export interface PortalPlanState {
  accountId: string;
  cancelledAt: string | null;
  contractId: string | null;
  lifecycleState: string;
  planLabel: string;
  resumesAt: string | null;
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

function currentBrowserId(): string | null {
  try {
    return globalThis.localStorage?.getItem(BROWSER_ID_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export async function readPortalPlanAccountId() {
  const browserId = currentBrowserId();
  if (!browserId) return null;
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: BROWSER_SESSION_TARGET,
      payload: { browser_id: browserId },
    });
    const body = readJsonReply<{ session?: unknown }>(reply.payload);
    const session = isRecord(body.session) ? body.session : null;
    return readString(session?.accountId);
  } catch {
    return null;
  }
}

export type AuthorityEffect = {
  kind?: unknown;
  object?: unknown;
  material?: Record<string, unknown>;
};

function planEffectRank(effect: AuthorityEffect) {
  const kind = String(effect.kind ?? '');
  if (!['account_plan', 'license_access', 'quote_reservation'].includes(kind)) return -1;
  const hasPlan = readString(effect.material?.canonical_plan_id) ?? readString(effect.material?.plan_id);
  const kindRank = kind === 'license_access' ? 3 : kind === 'account_plan' ? 2 : 1;
  return (hasPlan ? 10 : 0) + kindRank;
}

function effectTime(effect: AuthorityEffect) {
  const material = isRecord(effect.material) ? effect.material : {};
  return readString(material.occurred_at)
    ?? readString(material.cancelled_at)
    ?? readString(material.resume_at)
    ?? readString(material.created_at)
    ?? '';
}

export function portalPlanFromEffects(
  accountId: string,
  effects: readonly AuthorityEffect[],
): PortalPlanState {
  const plan = effects.reduce<AuthorityEffect | null>((selected, effect) => {
    if (planEffectRank(effect) < 0) return selected;
    if (!selected || planEffectRank(effect) > planEffectRank(selected)) return effect;
    return selected;
  }, null);
  const lifecycle = effects
    .filter((effect) => ['account_lifecycle', 'account_status', 'plan.lifecycle'].includes(String(effect.kind ?? '')))
    .reduce<AuthorityEffect | null>((selected, effect) => {
      if (!selected) return effect;
      return effectTime(effect) >= effectTime(selected) ? effect : selected;
    }, null);
  const canonicalPlanId =
    readString(plan?.material?.canonical_plan_id) ?? readString(plan?.material?.plan_id);
  const lifecycleEventType = readString(lifecycle?.material?.event_type);
  return {
    accountId,
    cancelledAt: readString(lifecycle?.material?.cancelled_at)
      ?? (lifecycleEventType === 'cancelled' ? readString(lifecycle?.material?.occurred_at) : null),
    contractId: readString(plan?.material?.contract_id) ?? readString(plan?.object),
    lifecycleState:
      readString(lifecycle?.material?.lifecycle_state)
      ?? lifecycleEventType
      ?? 'active',
    planLabel: readString(plan?.material?.plan_label) ?? canonicalPlanId ?? 'Signed access',
    resumesAt: readString(lifecycle?.material?.resume_at),
  };
}

export async function readPortalPlanState(): Promise<PortalPlanState | null> {
  const accountId = await readPortalPlanAccountId();
  if (!accountId) return null;
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: EFFECT_LIST_TARGET,
      payload: { subject: accountId },
    });
    const body = readJsonReply<{ effects?: AuthorityEffect[] }>(reply.payload);
    return portalPlanFromEffects(accountId, body.effects ?? []);
  } catch {
    return null;
  }
}
