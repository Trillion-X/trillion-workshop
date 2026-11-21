'use client';

// tools/take-payments/packages/billing/show/BillingScreen.tsx
//
// PURPOSE
//   The billing screen of one signed-in person: the plan they are on (Free, or their paid plan with its price, renewal or end
//   date and status), the other plans they could move to, and for a paid plan the card that pays it, its receipts, and three
//   one-click ways to change it (change card, change plan, cancel). Each button opens the matching step of Stripe's billing
//   page (tool:open-the-billing-page-for-one-purchase-and-show-the-card with a flow) and goes there; the buyer confirms the
//   change on Stripe's page, so cancelling takes no more steps than signing up. A free person sees the plans and no payment
//   step: nothing here opens a checkout.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file reads and changes nothing itself: the page comes from `readPage` and each step from `openFlow`, both
//      answered by the Workshop tools through web/src/workspace/billing-targets.ts. The plan and the other plans come from
//      the host (the member's offers and held access), never from this file.
//   2. No key, card number or fingerprint is ever shown; the card is brand, last four and expiry only.
//   3. Styling is the shared components and their layout classes only: no inline styles, no colours written here.
//   4. The screen never says there is nothing here. A part with nothing to show is not drawn; a read that is still going or
//      failed is drawn by the shared screen-state part, which centres its own states.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Badge, Button, Card, MetricRow, Text } from '../../../../ui';
import type { MetricCell } from '../../../../ui/show/metric-row/MetricRow';
import { ScreenState } from '../../../../ui/show/screen-state';
import { formatMoneyCents } from '../../../../ui/packages/ui/show/format-money';
import { billingScreenView } from './billing-screen-view';
import words from './billing-words.json' with { type: 'json' };

export type BillingFlow = 'payment_method_update' | 'subscription_update' | 'subscription_cancel';

/** The plan the person is on now: a paid plan's offer (its label and price), a subscription the offers do not describe
 *  (label null: the provider's read names it), or the free plan (paid false). */
export interface HeldPlan {
  id: string;
  label: string | null;
  paid: boolean;
  price_text: string | null;
}

/** A plan the person could move to, with its price. */
export interface OtherPlan {
  id: string;
  label: string;
  price_text: string;
}

export interface BillingPlan {
  label: string | null;
  amount_cents: number | null;
  currency: string | null;
  interval: string | null;
  quantity: number;
}

export interface BillingCard {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export interface BillingReceipt {
  id: string;
  number: string | null;
  created_at: string | null;
  status: string | null;
  amount_paid_cents: number | null;
  currency: string | null;
  receipt_url: string | null;
}

export interface BillingPage {
  subscription_id: string;
  status: string | null;
  cancel_at_period_end: boolean;
  renews_at: string | null;
  ends_at: string | null;
  plan: BillingPlan | null;
  card: BillingCard | null;
  receipts: BillingReceipt[];
}

export interface BillingScreenProps {
  /** False when the person holds no purchase: the screen reads nothing and shows the free plan with the other plans. */
  hasPurchase: boolean;
  plan: HeldPlan;
  otherPlans: OtherPlan[];
  readPage: () => Promise<BillingPage>;
  openFlow: (flow: BillingFlow) => Promise<{ redirect: string }>;
}

const FLOW_LABELS: Record<BillingFlow, string> = {
  payment_method_update: 'Change card',
  subscription_update: 'Change plan',
  subscription_cancel: 'Cancel plan',
};

const dateLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

const moneyLabel = (cents: number | null, currency: string | null) => (cents === null ? '—' : formatMoneyCents(cents, currency ?? 'usd'));

function statusBadge(page: BillingPage) {
  if (page.cancel_at_period_end) return <Badge variant="warning">Ends {dateLabel(page.ends_at ?? page.renews_at)}</Badge>;
  if (page.status === 'active' || page.status === 'trialing') return <Badge variant="success">{page.status === 'trialing' ? 'Trial' : 'Active'}</Badge>;
  return <Badge variant="error">{page.status ?? 'Unknown'}</Badge>;
}

function planCells(page: BillingPage, plan: HeldPlan): MetricCell[] {
  const price = page.plan ? `${moneyLabel(page.plan.amount_cents, page.plan.currency)} / ${page.plan.interval ?? 'period'}` : plan.price_text ?? '—';
  return [
    { label: 'Plan', value: page.plan?.label ?? plan.label ?? words.your_plan, mono: false },
    { label: 'Price', value: price, mono: false },
    { label: page.cancel_at_period_end ? 'Ends' : 'Renews', value: dateLabel(page.cancel_at_period_end ? page.ends_at : page.renews_at), mono: false },
  ];
}

function otherPlansCard(otherPlans: OtherPlan[]) {
  return (
    <Card variant="surface" padding="md" layout="stack">
      <Text variant="label">{words.other_plans}</Text>
      {otherPlans.map(other => (
        <div key={other.id} className="flex flex-row items-center justify-between gap-3">
          <Text variant="body">{other.label}</Text>
          <Text variant="body" color="muted">{other.price_text}</Text>
        </div>
      ))}
    </Card>
  );
}

export function BillingScreen({ hasPurchase, plan, otherPlans, readPage, openFlow }: BillingScreenProps) {
  const [page, setPage] = React.useState<BillingPage | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!hasPurchase) return undefined;
    let cancelled = false;
    setFailed(false);
    readPage().then(found => { if (!cancelled) setPage(found); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [hasPurchase, readPage, attempt]);

  const view = billingScreenView({ hasPurchase, loaded: page !== null, failed });
  if (view === 'read-error') return <ScreenState state={{ status: 'failed', title: words.read_error, retry: { label: words.try_again, run: () => setAttempt(count => count + 1) } }} />;
  if (view === 'free') {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Card variant="surface" padding="md" layout="stack">
          <Text variant="heading-lg">{words.free_plan}</Text>
          <MetricRow cells={[{ label: 'Plan', value: words.free_plan, mono: false }, { label: 'Price', value: words.free_price, mono: false }]} align="start" />
        </Card>
        {otherPlans.length > 0 && otherPlansCard(otherPlans)}
      </div>
    );
  }
  if (view === 'loading' || !page) return <ScreenState state={{ status: 'loading', label: words.loading }} />;

  // Each step is one press: the button waits on the page address, then the browser goes there.
  const change = (flow: BillingFlow) => openFlow(flow).then(({ redirect }) => { window.location.assign(redirect); });

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card variant="surface" padding="md" layout="stack">
        <div className="flex flex-row items-center justify-between gap-3">
          <Text variant="heading-lg">{page.plan?.label ?? plan.label ?? words.your_plan}</Text>
          {statusBadge(page)}
        </div>
        <MetricRow cells={planCells(page, plan)} align="start" />
        <div className="flex flex-row flex-wrap gap-2">
          <Button variant="secondary" size="md" onClick={() => change('payment_method_update')}>{FLOW_LABELS.payment_method_update}</Button>
          <Button variant="secondary" size="md" onClick={() => change('subscription_update')}>{FLOW_LABELS.subscription_update}</Button>
          {!page.cancel_at_period_end && (
            <Button variant="danger" size="md" onClick={() => change('subscription_cancel')}>{FLOW_LABELS.subscription_cancel}</Button>
          )}
        </div>
      </Card>

      {otherPlans.length > 0 && otherPlansCard(otherPlans)}

      {page.card && (
        <Card variant="surface" padding="md" layout="stack">
          <Text variant="label">{words.card}</Text>
          <Text variant="body">
            {page.card.brand.toUpperCase()} ending {page.card.last4}, expires {String(page.card.exp_month).padStart(2, '0')}/{page.card.exp_year}
          </Text>
        </Card>
      )}

      {page.receipts.length > 0 && (
        <Card variant="surface" padding="md" layout="stack">
          <Text variant="label">{words.receipts}</Text>
          {page.receipts.map(receipt => (
            <div key={receipt.id} className="flex flex-row items-center justify-between gap-3">
              <Text variant="body">{dateLabel(receipt.created_at)}{receipt.number ? ` · ${receipt.number}` : ''}</Text>
              <div className="flex flex-row items-center gap-3">
                <Text variant="body">{moneyLabel(receipt.amount_paid_cents, receipt.currency)}</Text>
                <Badge variant={receipt.status === 'paid' ? 'success' : 'neutral'}>{receipt.status ?? 'unknown'}</Badge>
                {receipt.receipt_url && (
                  <Button variant="plain" size="sm" onClick={() => window.open(receipt.receipt_url ?? undefined, '_blank', 'noopener')}>Receipt</Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
