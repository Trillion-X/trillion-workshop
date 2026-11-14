// packages/referrals/do-work/read-portal-referrals.ts
//
// Portal referral reader: the account the screen's input names -> the referral events kept in the person's own
// records -> projection. The retired reader asked the Bitfield runtime for the browser's session and then for the
// signed effect list (README.md of the tool lists each call); the fold itself is `referralStateFor` of the tool's
// read-data/referral-codes.mjs, which the retired TypeScript copy of it was ported to.

import { listRecords } from '#workspace/records-door';
import { referralStateFor } from '../../../read-data/referral-codes.mjs';
import eventList from '../../../read-data/referral-event-list.json' with { type: 'json' };

export interface ReferralStateProjection {
  referralCode: string | null;
  acceptedReferralCount: number;
}

export interface PortalReferralState extends ReferralStateProjection {
  accountId: string;
}

export type ReferralEvent = { kind?: unknown; subject?: unknown; material?: Record<string, unknown> };

let portalAccountId: string | null = null;

/** The account the screen is shown for: the screen's input names it, as the retired reader's browser session did. */
export function setPortalAccount(accountId: string | null) {
  portalAccountId = accountId;
}

export function portalAccount(): string | null {
  return portalAccountId;
}

/** Every referral event kept in the person's own records, oldest list order. */
export async function readReferralEvents(): Promise<ReferralEvent[]> {
  const records = await listRecords({ type: eventList.type });
  return records.flatMap(record => (record.value && typeof record.value === 'object' ? [record.value as ReferralEvent] : []));
}

export async function readPortalReferralState(): Promise<PortalReferralState | null> {
  const accountId = portalAccount();
  if (!accountId) return null;
  try {
    const own = (await readReferralEvents()).filter(event => event.subject === accountId);
    const state = referralStateFor(accountId, own);
    return { accountId, referralCode: state.referral_code, acceptedReferralCount: state.accepted_referral_count };
  } catch {
    return { accountId, acceptedReferralCount: 0, referralCode: null };
  }
}
