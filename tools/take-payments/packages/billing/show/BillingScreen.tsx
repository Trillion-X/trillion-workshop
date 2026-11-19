'use client';

// tools/take-payments/packages/billing/show/BillingScreen.tsx
//
// PURPOSE
//   The billing screen of one purchase: its plan, renewal or end date and status, the card that pays it, its receipts,
//   and three one-click ways to change it (change card, change plan, cancel). Each button opens the matching step of
//   Stripe's billing page (tool:open-the-billing-page-for-one-purchase-and-show-the-card with a flow) and goes there; the
//   buyer confirms the change on Stripe's page, so cancelling takes no more steps than signing up.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file reads and changes nothing itself: the page comes from `readPage` and each step from `openFlow`, both
//      answered by the Workshop tools through web/src/workspace/billing-targets.ts.
//   2. No key, card number or fingerprint is ever shown; the card is brand, last four and expiry only.
//   3. Styling is the shared components and their layout classes only: no inline styles, no colours written here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { CreditCard, Receipt } from 'lucide-react';
import { Badge, Button, Card, EmptyPlaceholder, LoadingOverlay, MetricRow, Text } from '../../../../ui';
import type { MetricCell } from '../../../../ui/show/metric-row/MetricRow';
import { formatMoneyCents } from '../../../../ui/packages/ui/show/format-money';

export type BillingFlow = 'payment_method_update' | 'subscription_update' | 'subscription_cancel';

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

function planCells(page: BillingPage): MetricCell[] {
  const plan = page.plan;
  return [
    { label: 'Plan', value: plan?.label ?? '—', mono: false },
    { label: 'Price', value: plan ? `${moneyLabel(plan.amount_cents, plan.currency)} / ${plan.interval ?? 'period'}` : '—', mono: false },
    { label: page.cancel_at_period_end ? 'Ends' : 'Renews', value: dateLabel(page.cancel_at_period_end ? page.ends_at : page.renews_at), mono: false },
  ];
}

export function BillingScreen({ readPage, openFlow }: BillingScreenProps) {
  const [page, setPage] = React.useState<BillingPage | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    readPage().then(found => { if (!cancelled) setPage(found); }, () => { if (!cancelled) setError('This purchase could not be read right now.'); });
    return () => { cancelled = true; };
  }, [readPage]);

  if (error) return <EmptyPlaceholder icon={CreditCard} message={error} />;
  if (!page) return <LoadingOverlay />;

  // Each step is one press: the button waits on the page address, then the browser goes there.
  const change = (flow: BillingFlow) => openFlow(flow).then(({ redirect }) => { window.location.assign(redirect); });

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card variant="surface" padding="md" layout="stack">
        <div className="flex flex-row items-center justify-between gap-3">
          <Text variant="heading-lg">{page.plan?.label ?? 'Your plan'}</Text>
          {statusBadge(page)}
        </div>
        <MetricRow cells={planCells(page)} align="start" />
        <div className="flex flex-row flex-wrap gap-2">
          <Button variant="secondary" size="md" onClick={() => change('payment_method_update')}>{FLOW_LABELS.payment_method_update}</Button>
          <Button variant="secondary" size="md" onClick={() => change('subscription_update')}>{FLOW_LABELS.subscription_update}</Button>
          {!page.cancel_at_period_end && (
            <Button variant="danger" size="md" onClick={() => change('subscription_cancel')}>{FLOW_LABELS.subscription_cancel}</Button>
          )}
        </div>
      </Card>

      <Card variant="surface" padding="md" layout="stack">
        <Text variant="label">Card</Text>
        {page.card ? (
          <Text variant="body">
            {page.card.brand.toUpperCase()} ending {page.card.last4}, expires {String(page.card.exp_month).padStart(2, '0')}/{page.card.exp_year}
          </Text>
        ) : (
          <Text variant="body" color="muted">No card is on file for this plan.</Text>
        )}
      </Card>

      <Card variant="surface" padding="md" layout="stack">
        <Text variant="label">Receipts</Text>
        {page.receipts.length === 0 ? (
          <EmptyPlaceholder icon={Receipt} message="No receipts yet" />
        ) : (
          page.receipts.map(receipt => (
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
          ))
        )}
      </Card>
    </div>
  );
}
