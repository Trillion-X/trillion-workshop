import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  currentBrowserSessionAccessKey,
  currentPresenterBrowserSessionId,
} from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';
import type { AccountStateProjection } from '../read-data/read-account-state';
import { consumeSurfaceUrlReturnActions } from './consume-url-return-actions';
import descriptorSeed from '../data/account-surface-descriptors.json';

const BROWSER_SESSION_TARGET = 'account-session.browser-session';
const EFFECT_LIST_TARGET = 'signed-event-authority.list-effects';
const LOGIN_LINK_TARGET = 'account-session.login-link';
const END_BROWSER_SESSION_TARGET = 'account-session.end-browser-session';

function readJsonReply<T>(payload: Uint8Array): T {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function currentBrowserId() {
  return currentPresenterBrowserSessionId();
}

export async function consumeAccountDashboardUrlReturnActions() {
  const returnActions = (descriptorSeed as { returnActions?: Parameters<typeof consumeSurfaceUrlReturnActions>[0] }).returnActions;
  return consumeSurfaceUrlReturnActions(returnActions, { browser: { id: currentBrowserId() } });
}

async function readBrowserSessionAccountId() {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: BROWSER_SESSION_TARGET,
      payload: { browser_id: currentBrowserId(), session_access_key: currentBrowserSessionAccessKey() },
    });
    const body = readJsonReply<{ session?: unknown }>(reply.payload);
    const session = isRecord(body.session) ? body.session : null;
    return typeof session?.accountId === 'string' && session.accountId.trim()
      ? session.accountId.trim()
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type AuthorityEffect = {
  kind?: unknown;
  object?: unknown;
  material?: Record<string, unknown>;
  proof?: { canonical_hash?: string };
};

function planEffectRank(effect: AuthorityEffect) {
  const kind = String(effect.kind ?? '');
  if (!['account_plan', 'license_access', 'quote_reservation'].includes(kind)) return -1;
  const hasPlan = readString(effect.material?.canonical_plan_id) ?? readString(effect.material?.plan_id);
  const kindRank =
    kind === 'license_access' ? 3 :
      kind === 'account_plan' ? 2 :
        1;
  return (hasPlan ? 10 : 0) + kindRank;
}

function strongestPlanEffect(effects: AuthorityEffect[]) {
  return effects.reduce<AuthorityEffect | null>((selected, effect) => {
    if (planEffectRank(effect) < 0) return selected;
    if (!selected || planEffectRank(effect) > planEffectRank(selected)) return effect;
    return selected;
  }, null);
}

function accountProjectionFromEffects(
  accountId: string,
  response: { effects?: AuthorityEffect[] },
): Partial<AccountStateProjection> {
  const effects = response.effects ?? [];
  const plan = strongestPlanEffect(effects);
  const lifecycle = effects.find((effect) =>
    ['account_lifecycle', 'account_status'].includes(String(effect.kind ?? '')),
  );
  const activation = effects.find((effect) => effect.kind === 'activation_count');
  const canonicalPlanId =
    readString(plan?.material?.canonical_plan_id) ?? readString(plan?.material?.plan_id);
  return {
    accountId,
    accountKey: accountId,
    activeActivationCount:
      readString(plan?.material?.active_activation_count) ??
      readString(plan?.material?.activation_count) ??
      readString(activation?.material?.active_activation_count),
    contractId: readString(plan?.material?.contract_id) ?? readString(plan?.object),
    currentPeriodEndsAt: readString(plan?.material?.current_period_ends_at),
    lifecycleState: readString(lifecycle?.material?.lifecycle_state) ?? 'active',
    planLabel: readString(plan?.material?.plan_label) ?? canonicalPlanId ?? 'Signed access',
    policyHash: readString(plan?.material?.policy_hash),
    quoteReservationId: readString(plan?.material?.quote_reservation_id),
  };
}

export async function readAccountDashboardSurfaceAccount() {
  const accountId = await readBrowserSessionAccountId();
  if (!accountId) return null;

  try {
    const reply = await sendRequestToBitfieldTarget({
      target: EFFECT_LIST_TARGET,
      payload: { subject: accountId },
    });
    return accountProjectionFromEffects(
      accountId,
      readJsonReply<{ effects?: { kind?: unknown; object?: unknown; material?: Record<string, unknown> }[] }>(
        reply.payload,
      ),
    );
  } catch {
    return null;
  }
}

export async function requestAccountDashboardLoginLink(
  email: string,
  returnPath = '/account',
) {
  const reply = await sendRequestToBitfieldTarget({
    target: LOGIN_LINK_TARGET,
    payload: { email, returnPath },
  });
  const body = readJsonReply<{ accepted?: unknown }>(reply.payload);
  if (body.accepted !== true) {
    throw new Error('Could not send the Bitfield sign-in link.');
  }
  return body as { accepted: true };
}

export async function endAccountDashboardBrowserSession() {
  await sendRequestToBitfieldTarget({
    target: END_BROWSER_SESSION_TARGET,
    payload: { browser_id: currentBrowserId(), session_access_key: currentBrowserSessionAccessKey() },
  });
}
