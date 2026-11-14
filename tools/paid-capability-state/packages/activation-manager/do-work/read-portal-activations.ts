// packages/activation-manager/do-work/read-portal-activations.ts
//
// Portal device-list reader: browser session -> signed effect list -> device rows.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const BROWSER_SESSION_TARGET = 'account-session.browser-session';
const EFFECT_LIST_TARGET = 'signed-event-authority.list-effects';
const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';

export interface PortalActivation {
  activationId: string;
  devicePublicKeyHash: string;
  label: string;
  lastSeenAt: string | null;
  status: string;
}

/**
 * What the portal Activations panel actually needs. `activeDeviceCount` is the
 * BILLABLE truth: a human account carries its live device count in its plan /
 * license effect (`active_activation_count`), NOT as one effect per device — the
 * per-device `activation_count` rows are keyed under the runtime/license subject,
 * not the account subject. So the count and the rows come from different effect
 * families; the panel shows the count as authoritative and lists whatever rows
 * are visible for this subject.
 */
export interface PortalActivationSummary {
  activeDeviceCount: number;
  totalDeviceCount: number;
  devices: PortalActivation[];
  planLabel: string | null;
  lifecycleState: string | null;
  hasPlan: boolean;
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

async function readBrowserSessionAccountId() {
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

type AuthorityEffect = {
  kind?: unknown;
  object?: unknown;
  material?: Record<string, unknown>;
};

const ACTIVATION_EFFECT_KINDS = ['activation', 'device_activation', 'activation_lease', 'device_grant', 'activation_count'];
// Account-scoped effects that carry the billable device count in their material.
const PLAN_EFFECT_KINDS = ['account_plan', 'license_access', 'account_lifecycle'];

function readCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Math.max(0, Math.trunc(Number(value)));
  }
  return null;
}

function effectOccurredAt(effect: AuthorityEffect): string {
  const material = isRecord(effect.material) ? effect.material : {};
  return readString(material.occurred_at) ?? readString(material.current_period_ends_at) ?? '';
}

/**
 * The account's live device count from the newest plan/license effect. These
 * effects (account_plan / license_access) carry `active_activation_count` — the
 * number Bitfield bills on (per active device). Newest effect wins so a pause /
 * resume / plan change is reflected. Returns null when the account has no plan.
 */
export function planDeviceCountFromEffects(effects: readonly AuthorityEffect[]): {
  activeDeviceCount: number | null;
  planLabel: string | null;
  lifecycleState: string | null;
} {
  const planEffects = effects
    .filter((effect) => PLAN_EFFECT_KINDS.includes(String(effect.kind ?? '')))
    .filter((effect) => {
      const material = isRecord(effect.material) ? effect.material : {};
      return readCount(material.active_activation_count) !== null
        || readString(material.plan_label) !== null
        || readString(material.lifecycle_state) !== null;
    })
    .sort((left, right) => effectOccurredAt(right).localeCompare(effectOccurredAt(left)));

  for (const effect of planEffects) {
    const material = isRecord(effect.material) ? effect.material : {};
    const count = readCount(material.active_activation_count) ?? readCount(material.activation_count);
    if (count !== null) {
      return {
        activeDeviceCount: count,
        planLabel: readString(material.plan_label),
        lifecycleState: readString(material.lifecycle_state) ?? readString(material.status),
      };
    }
  }
  return { activeDeviceCount: null, planLabel: null, lifecycleState: null };
}

export function activationFromEffect(effect: AuthorityEffect): PortalActivation | null {
  const kind = String(effect.kind ?? '');
  const material = isRecord(effect.material) ? effect.material : {};
  const looksLikeActivation =
    ACTIVATION_EFFECT_KINDS.includes(kind) ||
    readString(material.activation_id) !== null ||
    readString(material.device_public_key_hash) !== null;
  if (!looksLikeActivation) return null;

  const activationId = readString(material.activation_id) ?? readString(effect.object);
  const devicePublicKeyHash = readString(material.device_public_key_hash);
  if (!activationId || !devicePublicKeyHash) return null;

  return {
    activationId,
    devicePublicKeyHash,
    label: readString(material.device_label) ?? activationId,
    lastSeenAt: readString(material.last_seen_at) ?? readString(material.occurred_at),
    status: readString(material.status) ?? kind ?? 'unknown',
  };
}

/** Pure fold of an account's effects into the panel summary (count + device rows). */
export function summaryFromEffects(effects: readonly AuthorityEffect[]): PortalActivationSummary {
  const seen = new Set<string>();
  const devices: PortalActivation[] = [];
  for (const effect of effects) {
    const activation = activationFromEffect(effect);
    if (!activation || seen.has(activation.devicePublicKeyHash)) continue;
    seen.add(activation.devicePublicKeyHash);
    devices.push(activation);
  }
  const plan = planDeviceCountFromEffects(effects);
  const rowActive = devices.filter((device) => device.status.toLowerCase() === 'active').length;
  // The plan's active_activation_count is authoritative for the billable count;
  // fall back to the visible active-row count when there is no plan effect.
  const activeDeviceCount = plan.activeDeviceCount ?? rowActive;
  return {
    activeDeviceCount,
    totalDeviceCount: Math.max(activeDeviceCount, devices.length),
    devices,
    planLabel: plan.planLabel,
    lifecycleState: plan.lifecycleState,
    hasPlan: plan.activeDeviceCount !== null,
  };
}

export async function readPortalActivationSummary(): Promise<PortalActivationSummary | null> {
  const accountId = await readBrowserSessionAccountId();
  if (!accountId) return null;
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: EFFECT_LIST_TARGET,
      payload: { subject: accountId },
    });
    const body = readJsonReply<{ effects?: AuthorityEffect[] }>(reply.payload);
    return summaryFromEffects(body.effects ?? []);
  } catch {
    return null;
  }
}

export async function readPortalActivations(): Promise<PortalActivation[] | null> {
  const summary = await readPortalActivationSummary();
  return summary ? summary.devices : null;
}
