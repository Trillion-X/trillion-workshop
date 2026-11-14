// packages/referrals/read-data/read-referral-state.ts
//
// Referral state projection folded from signed effects.

export interface ReferralStateProjection {
  referralCode: string | null;
  acceptedReferralCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type ReferralEffect = {
  kind?: unknown;
  subject?: unknown;
  material?: Record<string, unknown>;
};

function effectTime(effect: ReferralEffect) {
  const material = isRecord(effect.material) ? effect.material : {};
  return readString(material.occurred_at) ?? readString(material.created_at) ?? '';
}

export function referralStateFromEffects(
  accountId: string,
  effects: readonly ReferralEffect[],
): ReferralStateProjection {
  const referralCode = [...effects]
    .sort((left, right) => effectTime(right).localeCompare(effectTime(left)))
    .map((effect) => {
      const material = isRecord(effect.material) ? effect.material : {};
      const eventType = readString(material.event_type) ?? readString(effect.kind);
      return eventType === 'referral_code_created' || eventType === 'referral.code'
        ? readString(material.referral_code)
        : null;
    })
    .find((code): code is string => !!code) ?? null;

  const acceptedReferralCount = effects.filter((effect) => {
    const material = isRecord(effect.material) ? effect.material : {};
    const eventType = readString(material.event_type) ?? readString(effect.kind);
    return (eventType === 'referral_signup' || eventType === 'referral.signup')
      && readString(material.referrer_account_id) === accountId;
  }).length;

  return { acceptedReferralCount, referralCode };
}
