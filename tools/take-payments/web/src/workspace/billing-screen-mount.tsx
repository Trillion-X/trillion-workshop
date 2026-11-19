// tools/take-payments/web/src/workspace/billing-screen-mount.tsx
//
// PURPOSE
//   The billing screen's module entry (tool:show-one-purchase-plan-card-and-receipts's screen): the one file the screen's
//   row names (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). It takes the purchase the screen names (`subscription_id`, the sub_ id of one
//   purchase) and the seller connection, and mounts BillingScreen with the page and step answered by billing-targets.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { mountReactSurface } from '../../../../ui';
import { BillingScreen } from '../../../packages/billing/show/BillingScreen';
import { openBillingFlow, readBillingPage } from './billing-targets';

type BillingScreenInput = { subscription_id?: string; subject_email?: string; seller_connection?: string; [key: string]: unknown };

// subject_email is the signed-in buyer's verified email, given by the host that mounts the screen; the purchase must be theirs.
export function mount(element: HTMLElement, props: BillingScreenInput = {}) {
  const { subscription_id: subscriptionId = '', subject_email: subjectEmail = '', seller_connection: sellerConnection } = props;
  return mountReactSurface(element, (
    <BillingScreen
      readPage={() => readBillingPage(subscriptionId, subjectEmail, sellerConnection)}
      openFlow={flow => openBillingFlow(subscriptionId, subjectEmail, flow, sellerConnection)}
    />
  ));
}
