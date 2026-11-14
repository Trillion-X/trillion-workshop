// tools/referral-codes-and-rewards/web/referrals-screen-mount.tsx
//
// PURPOSE
//   The referrals panel (tool:work-out-referral-codes' screen) as a screen module: the one file the screen's row names
//   (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The panel itself is ../packages/referrals/show/app-shell/ReferralsPortalSurface.tsx,
//   moved here byte for byte from bitfield-packages (moved-from.json); its two engine-call files are edited where they
//   called the retired Bitfield runtime (README.md lists each call). This file hands the panel the account, the target a
//   new code points at and the code prefix the screen's input names; it takes the place of the retired package entry
//   (mount-referrals-portal.tsx), which is not carried.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account, the target `{ on, value }` and the prefix come only from the screen's input; nothing here names an
//      account, a product or a seller. Without a target the panel can still apply a code but cannot make one.
//   2. Nothing here reads or writes a row: the panel reads and keeps events through packages/referrals/do-work.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { ReferralsPortalSurface } from '../packages/referrals/show/app-shell/ReferralsPortalSurface';
import { setPortalAccount } from '../packages/referrals/do-work/read-portal-referrals';
import { setReferralCodeTarget } from '../packages/referrals/do-work/send-referral-event';

type ReferralsScreenInput = {
  account_id?: unknown;
  referral_code_prefix?: unknown;
  code_target?: { on?: unknown; value?: unknown };
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function mount(element: HTMLElement, props: ReferralsScreenInput = {}) {
  setPortalAccount(text(props.account_id) || null);
  const on = text(props.code_target?.on);
  const value = text(props.code_target?.value);
  setReferralCodeTarget(on && value ? { on, value } : null);
  const codePrefix = text(props.referral_code_prefix) || 'REF';
  return mountReactSurface(
    element,
    <ErrorBoundary zoneName="referrals-portal">
      <ReferralsPortalSurface codePrefix={codePrefix} />
    </ErrorBoundary>,
  );
}
