// src/workspace/sales-contract-builder-surface.tsx
//
// PROVENANCE
//   The contract primitives, their editors, the payment-structure maths (phases, installments with APR and discount
//   ramps, resource calculator) and the template stack are ported from
//   the sales-contract-builder package (show/SalesContractBuilderSurface.tsx).
//   The screen around them was rebuilt for Trillion on 2026-10-02 (anatomy only, no code copied):
//   Stripe's quote and invoice editors (customer and items on the left, a summary with the total and what bills when on
//   the right: mobbin.com/screens/e562a189-7863-4abf-9fa8-cdd6cca6de62, mobbin.com/screens/e7f48227-11ec-4f4d-9566-dcf31b4e7aa8),
//   Calendly's "When this happens / Do this" automation (mobbin.com/screens/93b563ee-f1b3-4374-a626-c13cf231893d) and
//   Klaviyo's flow steps (mobbin.com/screens/292692f1-6a9f-4b0f-82b5-1e425c0aa185) for what runs after they pay;
//   21st.dev Order Summary Separator (29356) for the summary, Choicebox (34720) and Preferences Card (30553) for rows
//   with an icon, a name, one muted line and a check; and a set of visual-hierarchy reference sheets (pairs 01, 13, 14, 18:
//   one summary with the big number, choices are rows, ask only what is needed side by side).
//
// PURPOSE
//   Build a deal from what the business really has: the customer (their lists and their payment service), the offer
//   and its real price (their payment service's prices), the payment terms, extra rules (access, usage, performance
//   payments, fees, entitlements), who it goes to and what runs after they pay (their own rules and schedules, set when
//   it is sent). The summary on the right shows the deal at a glance with its total as the one big number.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names an offer, a customer, a payment service or a follow-up: they arrive as `resources`
//      (tool:manage-sales-contracts operation `resources`, src/sales-contract-builder.json sources) and the follow-ups
//      and plain words for metrics, events and conditions are rows of src/sales-contract-builder.json.
//   2. No price is fixed in code; an offer's price is the one its payment service keeps.
//   3. Every control is a shared part (parts/ui); this file writes no markup of its own.
//   4. Save, send and the follow-ups go through tool:manage-sales-contracts, the same tool an AI runs.

import React from 'react';
import {AnimatePresence, useReducedMotion, type Variants} from 'framer-motion';
import { motion } from '../../../../ui/motion/lazy-motion.tsx';
import { Badge, Button, Card, Container, DisclosureSection, Dropdown, Input, NamedIcon, SchemaValueView, SegmentedControl, Text, Textarea, ToastProvider } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { cn } from '../../parts/ui/show/cn';
import { useToastContext } from '../../parts/ui/show/toast';
import { ListingCard, ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { ChoiceList } from '../../parts/ui/show/choice-list';
import { FloatingPanel } from '../../parts/screen-arrangement/show/FloatingPanel';
import { openSharing } from './sharing-sheet';
import { CopyButton } from '../../parts/ui/show/copy-button/CopyButton';
import { openScreen } from './open-screen';
import { replaceWorkspaceAddress } from './addresses.mjs';
import { runWorkshopTool } from './workshop-tool-api';
import { startSellerPaymentConnect } from './seller-payment-connect.mjs';
import { SendToAnAudience, type AudienceSendContent } from './send-to-an-audience';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
export type SavedSalesContract = { id: string; kind: 'sales-contract'; status: 'draft'; name: string; contract: Record<string, unknown> };

/** One thing the business has, as the builder reads it (src/sales-contract-builder.json `each`). */
export type DealResource = { id: string; label?: string; detail?: string; picture?: string; amount_cents?: number; currency?: string; interval?: string; interval_count?: number; email?: string; when?: string };
export type DealSource = { id: string; group: string; label: string; state: 'read' | 'not_connected' | 'unread'; reason?: string; connection?: string; items: DealResource[] };
export type DealResources = { sources: DealSource[] };

async function saveSalesContract(contract: Record<string, unknown>): Promise<SavedSalesContract> {
  const result = await runWorkshopTool<SavedSalesContract>('tool:manage-sales-contracts', { operation: 'save', contract });
  const saved = result.result;
  if (!saved?.id) throw new Error(result.error || 'The contract could not be saved.');
  return saved;
}

type FollowUpSet = { label: string; rule_id?: string; schedule_id?: string; once_at?: string; refused?: string };
type SentSalesContract = { contract_id: string; share_id: string; address: string; offer_id: string; sent_to?: string; sent_at?: string; follow_ups?: FollowUpSet[] };
/** The contract's link and its priced offer, emailed when `to` names the person, and its follow-ups set: the same tool an AI runs. */
async function sendSalesContract(input: Record<string, unknown>): Promise<SentSalesContract> {
  const result = await runWorkshopTool<SentSalesContract>('tool:manage-sales-contracts', { operation: 'send', ...input });
  if (!result.result?.address) throw new Error(result.error || 'The contract could not be sent.');
  return result.result;
}

type PrimitiveType =
  | 'Commitment'
  | 'GrantAccess'
  | 'MeterUsage'
  | 'Royalty'
  | 'TransactionFee'
  | 'Entitlement';

type BillingInterval = 'day' | 'week' | 'month' | 'quarter' | 'year';
type PaymentStructure = 'simple' | 'phased' | 'installment';
type CurrencyCode = 'usd' | 'eur' | 'gbp' | 'cad' | 'aud';
type FeeType = 'fixed' | 'percentage';
type AccessCondition = 'lifetime' | 'time_limited' | 'usage_based' | 'conditional';
type ConstraintOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'contains';
type LogicOperator = 'AND' | 'OR';
type BuilderStep = 'setup' | 'payments' | 'extras' | 'share';
type LinkScope = 'public' | 'private' | 'email' | 'phone' | 'code';

type PaymentScheduleItem = {
  id: string;
  amount_cents: number;
  due_days_from_start: number;
  label: string;
};

type PricingPhase = {
  id: string;
  duration_months: number;
  discount_percentage: number;
  amount_override_cents?: number;
};

type OngoingSubscription = {
  amount_cents: number;
  interval: BillingInterval;
  interval_count: number;
  start_days_from_contract: number;
};

type InstallmentGenerator = {
  mode: 'per_payment' | 'total_split';
  count: number;
  amount_cents: number;
  total_cents: number;
  interval_count: number;
  interval_unit: BillingInterval;
  start_day: number;
  apr_percent: number;
  discount_percent: number;
};

type ResourceCalculatorSelection = Record<string, { selected: boolean; price_cents: number }>;

type CommitmentMetadata = {
  payment_structure: PaymentStructure;
  payment_schedule?: PaymentScheduleItem[];
  pricing_phases?: PricingPhase[];
  ongoing_subscription?: OngoingSubscription;
  trial_period_days?: number;
  custom_interval?: number;
  custom_interval_unit?: BillingInterval;
  apr_percent?: number;
  apr_mode?: 'nominal' | 'effective';
  grace_period_days?: number;
  late_fee_cents?: number;
  generator?: InstallmentGenerator;
  resource_calculator?: ResourceCalculatorSelection;
};

type ConstraintRule = {
  id: string;
  constraint_id: string;
  operator: ConstraintOperator;
  value: string;
  logic_operator: LogicOperator;
};

type CommitmentPrimitive = {
  type: 'Commitment';
  label: string;
  amount: number;
  total_amount?: number;
  currency: CurrencyCode;
  recurrence: 'one_time' | 'weekly' | 'bi_weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
  metadata: CommitmentMetadata;
};

type GrantAccessPrimitive = {
  type: 'GrantAccess';
  label: string;
  resource: string;
  condition: AccessCondition;
  linked_commitment_id?: string;
  duration_amount?: number;
  duration_unit?: 'days' | 'weeks' | 'months' | 'years';
  usage_limit?: number;
  constraint_rules?: ConstraintRule[];
};

type MeterUsagePrimitive = {
  type: 'MeterUsage';
  label: string;
  resource: string;
  metric: string;
  linked_commitment_id?: string;
  pricing_rules: {
    per_unit_cents: number;
    included_units?: number;
    tiers?: Array<{ id: string; min: number; max?: number; price_cents: number }>;
  };
};

type RoyaltyPrimitive = {
  type: 'Royalty';
  label: string;
  claimant: string;
  linked_commitment_id?: string;
  amount_cents?: number;
  percentage?: number;
  trigger_event: string;
};

type TransactionFeePrimitive = {
  type: 'TransactionFee';
  label: string;
  fee_type: FeeType;
  linked_commitment_id?: string;
  fee_amount_cents?: number;
  fee_percentage?: number;
  recipient: string;
  basis_transaction: string;
};

type EntitlementPrimitive = {
  type: 'Entitlement';
  label: string;
  linked_commitment_id?: string;
  item_type: string;
  item_name: string;
  quantity: number;
  transferable: boolean;
};

export type ContractPrimitive =
  | CommitmentPrimitive
  | GrantAccessPrimitive
  | MeterUsagePrimitive
  | RoyaltyPrimitive
  | TransactionFeePrimitive
  | EntitlementPrimitive;

type PrimitiveLineItem = {
  clientId: string;
  primitive: ContractPrimitive;
};

type CommitmentBlock = {
  id: string;
  commitment: PrimitiveLineItem & { primitive: CommitmentPrimitive };
  relatedPrimitives: PrimitiveLineItem[];
};

export type ContractTemplate = {
  id: string;
  name: string;
  description: string;
  rules: ContractPrimitive[];
  sourceTerms?: Record<string, unknown>;
};

/** Who the deal is for: one of the person's customers, or someone new they type. */
type Buyer = { id?: string; name: string; email: string };
/** An offer or resource a rule can point at, with the price its payment service keeps. */
type Offer = { id: string; label: string; detail?: string; price_cents?: number; currency?: string; interval?: string; interval_count?: number };
type Option = { value: string; label: string; description?: string; icon?: string; disabled?: boolean };
type AfterPaymentStep = { id: string; label: string; detail: string; icon: string; on: 'paid' | { after_days: number; at: string }; chosen?: boolean; then: { tool_id?: string; workflow_id?: string; input: Record<string, unknown> } };

type BuilderWords = Record<'metrics' | 'events' | 'conditions', Array<{id:string;label:string}>>;
export type SalesBuilderContent = {words_for:BuilderWords;after_payment:{steps:AfterPaymentStep[];workflow_step?:{label:string;detail:string;icon:string;on:'paid'}};screens:Record<string,string>};
export type AudienceContent = AudienceSendContent;

const BUILDER_STEPS: Array<{ id: BuilderStep; title: string; icon: string }> = [
  { id: 'setup', title: 'Deal', icon: 'Handshake' },
  { id: 'payments', title: 'Payments', icon: 'Banknote' },
  { id: 'extras', title: 'Extras', icon: 'KeyRound' },
  { id: 'share', title: 'Send', icon: 'Send' },
];

const PAYMENT_STRUCTURE_LABELS: Record<PaymentStructure, string> = {
  simple: 'Simple',
  phased: 'Phased',
  installment: 'Installments',
};

const RECURRENCE_LABELS: Record<CommitmentPrimitive['recurrence'], string> = {
  one_time: 'One-time',
  weekly: 'Weekly',
  bi_weekly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom schedule',
};

/** The unit after the big number in the summary. */
const RECURRENCE_UNITS: Record<CommitmentPrimitive['recurrence'], string> = {
  one_time: '',
  weekly: '/week',
  bi_weekly: '/2 weeks',
  monthly: '/month',
  quarterly: '/quarter',
  yearly: '/year',
  custom: '',
};

const CURRENCIES: Record<CurrencyCode, { symbol: string; code: string }> = {
  usd: { symbol: '$', code: 'USD' },
  eur: { symbol: 'EUR ', code: 'EUR' },
  gbp: { symbol: 'GBP ', code: 'GBP' },
  cad: { symbol: 'C$ ', code: 'CAD' },
  aud: { symbol: 'A$ ', code: 'AUD' },
};

const BILLING_INTERVALS: Record<BillingInterval, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
};

const LINK_SCOPES: Option[] = [
  { value: 'email', label: 'Only their email address', description: 'They confirm it with a one-time code. No account needed.', icon: 'Mail' },
  { value: 'public', label: 'Anyone with the link', description: 'No sign in to open it', icon: 'Globe' },
  { value: 'private', label: 'A Trillion person', description: 'Someone you know on Trillion', icon: 'UserRound' },
  { value: 'phone', label: 'A phone number', description: 'They confirm the number to open it', icon: 'Smartphone' },
  { value: 'code', label: 'A code they know', description: 'They type the code to open it', icon: 'KeyRound' },
];

const PRIMITIVE_LIBRARY: Array<{ type: PrimitiveType; title: string; shortTitle: string; description: string; icon: string }> = [
  { type: 'Commitment', title: 'Payment', shortTitle: 'Payment', description: 'One-time, repeating, phased or in installments.', icon: 'Banknote' },
  { type: 'GrantAccess', title: 'Access', shortTitle: 'Access', description: 'What they get, for how long or how much.', icon: 'KeyRound' },
  { type: 'MeterUsage', title: 'Pay per use', shortTitle: 'Usage', description: 'A price for each unit they use.', icon: 'Gauge' },
  { type: 'Royalty', title: 'Performance payment', shortTitle: 'Performance', description: 'Paid when an outcome happens.', icon: 'Trophy' },
  { type: 'TransactionFee', title: 'Transaction fee', shortTitle: 'Fee', description: 'A fixed or percentage fee on each payment.', icon: 'Percent' },
  { type: 'Entitlement', title: 'Certificate or license', shortTitle: 'Entitlement', description: 'Something they keep, like a badge or license.', icon: 'BadgeCheck' },
];

const DEFAULT_GENERATOR: InstallmentGenerator = {
  mode: 'per_payment',
  count: 12,
  amount_cents: 0,
  total_cents: 0,
  interval_count: 1,
  interval_unit: 'month',
  start_day: 0,
  apr_percent: 0,
  discount_percent: 0,
};

const LIST_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -10, scale: 0.96, filter: 'blur(2px)' },
  visible: (index: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 400, damping: 25, delay: Math.min(index, 4) * 0.08 },
  }),
  exit: { opacity: 0, y: -6, scale: 0.98, filter: 'blur(1px)', transition: { duration: 0.16 } },
};

const COLLAPSE_VARIANTS: Variants = {
  hidden: { opacity: 0, height: 0, overflow: 'hidden' },
  visible: { opacity: 1, height: 'auto', overflow: 'hidden', transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } },
};

const DEFAULT_NAME = 'New deal';
const NEW_BUYER = 'someone-new';

/** An id such as `access:coaching-calls` in plain words ("coaching calls"). */
function humanWords(id: string): string {
  return id.replace(/^[^:]+:/, '').replace(/[-_]+/g, ' ');
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Math.random().toString(36).slice(2)}`;
}

function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCIES, value);
}

function money(cents: number | undefined, currency: CurrencyCode = 'usd'): string {
  const config = CURRENCIES[currency];
  return `${config.symbol}${((cents ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** An offer's price in words ("$2,500.00 a month"), or nothing when it has none. */
function offerPrice(offer: Offer): string {
  if (offer.price_cents === undefined) return '';
  const currency = isCurrency(offer.currency) ? offer.currency : 'usd';
  const every = offer.interval ? ` every ${offer.interval_count && offer.interval_count > 1 ? `${offer.interval_count} ${offer.interval}s` : offer.interval}` : ' once';
  return `${money(offer.price_cents, currency)}${every}`;
}

function centsFromDisplay(value: string): number {
  const cleaned = value.replace(/[^\d.]/g, '');
  if (!cleaned || cleaned === '.') return 0;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return (Number.parseInt(whole, 10) || 0) * 100 + (Number.parseInt(`${fraction}00`.slice(0, 2), 10) || 0);
}

function displayFromCents(cents: number | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

function daysForInterval(count: number, unit: BillingInterval): number {
  const multipliers: Record<BillingInterval, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
  return Math.max(1, count) * multipliers[unit];
}

function paymentWithApr(totalPrincipal: number, aprPercent: number, count: number, intervalDays: number): number {
  if (count <= 0) return 0;
  const periodicRate = (aprPercent / 100) * (intervalDays / 365);
  if (periodicRate <= 0) return Math.round(totalPrincipal / count);
  const denominator = 1 - Math.pow(1 + periodicRate, -count);
  return Math.round((totalPrincipal * periodicRate) / denominator);
}

function commitmentTotal(primitive: CommitmentPrimitive): number {
  if (primitive.metadata.payment_schedule?.length) return primitive.metadata.payment_schedule.reduce((sum, item) => sum + item.amount_cents, 0);
  return primitive.total_amount ?? primitive.amount ?? 0;
}

/** How a price repeats on its payment service, as the builder's recurrence. */
function recurrenceOf(offer: Offer): Pick<CommitmentPrimitive, 'recurrence'> & { metadata: CommitmentMetadata } {
  const count = offer.interval_count ?? 1;
  if (!offer.interval) return { recurrence: 'one_time', metadata: { payment_structure: 'simple' } };
  if (offer.interval === 'week' && count === 2) return { recurrence: 'bi_weekly', metadata: { payment_structure: 'simple' } };
  if (offer.interval === 'month' && count === 3) return { recurrence: 'quarterly', metadata: { payment_structure: 'simple' } };
  if (count === 1 && offer.interval === 'week') return { recurrence: 'weekly', metadata: { payment_structure: 'simple' } };
  if (count === 1 && offer.interval === 'month') return { recurrence: 'monthly', metadata: { payment_structure: 'simple' } };
  if (count === 1 && offer.interval === 'year') return { recurrence: 'yearly', metadata: { payment_structure: 'simple' } };
  return { recurrence: 'custom', metadata: { payment_structure: 'simple', custom_interval: count, custom_interval_unit: offer.interval as BillingInterval } };
}

function cloneRulesAsLineItems(rules: ContractPrimitive[]): PrimitiveLineItem[] {
  const firstCommitmentId = makeId('commitment');
  let commitmentAssigned = false;
  return rules.map((primitive) => {
    const clientId = primitive.type === 'Commitment' && !commitmentAssigned ? firstCommitmentId : makeId(primitive.type.toLowerCase());
    if (primitive.type === 'Commitment') commitmentAssigned = true;
    const cloned = structuredClone(primitive) as ContractPrimitive;
    if (cloned.type !== 'Commitment' && !cloned.linked_commitment_id) cloned.linked_commitment_id = firstCommitmentId;
    return { clientId, primitive: cloned };
  });
}

function defaultPrimitive(type: PrimitiveType, currency: CurrencyCode, firstOffer: string, words:BuilderWords, linkedCommitmentId?: string): ContractPrimitive {
  switch (type) {
    case 'Commitment':
      return { type, label: 'Payment', amount: 0, currency, recurrence: 'one_time', metadata: { payment_structure: 'simple' } };
    case 'GrantAccess':
      return { type, label: 'Access', resource: firstOffer, condition: 'lifetime', linked_commitment_id: linkedCommitmentId };
    case 'MeterUsage':
      return { type, label: 'Pay per use', resource: firstOffer, metric: words.metrics[0]?.id ?? '', linked_commitment_id: linkedCommitmentId, pricing_rules: { per_unit_cents: 0, included_units: 0 } };
    case 'Royalty':
      return { type, label: 'Performance payment', claimant: 'party:seller', amount_cents: 0, trigger_event: words.events[0]?.id ?? '', linked_commitment_id: linkedCommitmentId };
    case 'TransactionFee':
      return { type, label: 'Transaction fee', fee_type: 'percentage', fee_percentage: 0, recipient: 'party:seller', basis_transaction: 'event:payment_processed', linked_commitment_id: linkedCommitmentId };
    case 'Entitlement':
      return { type, label: 'Certificate or license', item_type: 'license', item_name: 'License', quantity: 1, transferable: false, linked_commitment_id: linkedCommitmentId };
  }
}

function primitiveInfo(type: PrimitiveType) {
  return PRIMITIVE_LIBRARY.find((item) => item.type === type) ?? PRIMITIVE_LIBRARY[0];
}

function commitmentSummary(block: CommitmentBlock): string {
  const commitment = block.commitment.primitive;
  const extras = block.relatedPrimitives.length === 1 ? '1 extra' : `${block.relatedPrimitives.length} extras`;
  return `${PAYMENT_STRUCTURE_LABELS[commitment.metadata.payment_structure]} · ${RECURRENCE_LABELS[commitment.recurrence]} · ${extras}`;
}

function selectedResourceTotalCents(selections: ResourceCalculatorSelection): number {
  return Object.values(selections).reduce((sum, selection) => (selection.selected ? sum + selection.price_cents : sum), 0);
}

function cleanPrimitiveForOutput(item: PrimitiveLineItem): Record<string, unknown> {
  const primitive = structuredClone(item.primitive) as ContractPrimitive;
  if (primitive.type === 'Commitment') primitive.total_amount = commitmentTotal(primitive);
  return primitive as unknown as Record<string, unknown>;
}

/** The items of every source that fills one builder choice, newest source first, each id once. */
function itemsOf(resources: DealResources, group: string): DealResource[] {
  const seen = new Set<string>();
  return resources.sources.filter(source => source.group === group).flatMap(source => source.items).filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/** The sources of one choice that could not be read, so the screen can say why something is missing. */
function unreadOf(resources: DealResources, group: string): DealSource[] {
  return resources.sources.filter(source => source.group === group && source.state !== 'read');
}

/** When a step that waits some days after sending runs: that many days from now at the step's local time. */
function onceAtFor(on: { after_days: number; at: string }, from = new Date()): string {
  const [hours, minutes] = on.at.split(':').map(part => Number.parseInt(part, 10) || 0);
  const when = new Date(from);
  when.setDate(when.getDate() + on.after_days);
  when.setHours(hours, minutes, 0, 0);
  return when.toISOString();
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <Container as="label" layout="vertical" gap="xs" className={cn('min-w-0', className)}>
      <Text as="span" variant="label" color="muted">{label}</Text>
      {children}
      {hint && <Text as="span" variant="caption" color="faint">{hint}</Text>}
    </Container>
  );
}

/** A choice from a list: rows with an icon, a name and one muted line when the options carry them. */
function SelectField({ label, value, onChange, items, hint, className, placeholder }: { label: string; value: string; onChange: (value: string) => void; items: Option[]; hint?: string; className?: string; placeholder?: string }) {
  return (
    <Field label={label} hint={hint} className={className}>
      <Dropdown
        items={items}
        value={value}
        onValueChange={onChange}
        aria-label={label}
        placeholder={placeholder ?? label}
        scrollable
        className="flex h-10 min-h-10 w-full justify-between rounded-xl border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-3 py-2 text-sm"
      />
    </Field>
  );
}

function MoneyInput({ label, cents, currency, onChange, hint, className, inputClassName }: { label: string; cents: number | undefined; currency: CurrencyCode; onChange: (cents: number) => void; hint?: string; className?: string; inputClassName?: string }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const committedValue = displayFromCents(cents);
  const value = draft ?? committedValue;
  const commit = React.useCallback((raw: string) => {
    onChange(centsFromDisplay(raw));
    setDraft(null);
  }, [onChange]);
  return (
    <Field label={label} hint={hint} className={className}>
      <Input
        icon={<Text as="span" variant="caption" aria-hidden="true">{CURRENCIES[currency].symbol.trim() || '$'}</Text>}
        inputMode="decimal"
        value={value}
        onFocus={() => setDraft((current) => current ?? committedValue)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
          if (event.key === 'Escape') setDraft(null);
        }}
        className={cn('h-10 min-h-10', inputClassName)}
      />
    </Field>
  );
}

function NumberField({ label, value, onCommit, min, decimals }: { label: string; value: number; onCommit: (value: number) => void; min?: number; decimals?: boolean }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = (raw: string) => {
    const parsed = decimals ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
    onCommit(Number.isFinite(parsed) ? Math.max(min ?? Number.NEGATIVE_INFINITY, parsed) : value);
    setDraft(null);
  };
  return (
    <Field label={label}>
      <Input
        type="text"
        inputMode={decimals ? 'decimal' : 'numeric'}
        value={shown}
        onFocus={() => setDraft((current) => current ?? String(value))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
          if (event.key === 'Escape') setDraft(null);
        }}
        className="h-10 min-h-10"
      />
    </Field>
  );
}

function IconBox({ icon, className }: { icon: string; className?: string }) {
  return (
    <Card variant="nested" padding="none" className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', className)}>
      <NamedIcon name={icon} size="sm" />
    </Card>
  );
}

/** A titled part of a step: an icon, a title, one muted line, and its own action on the right. */
function Section({ icon, title, line, action, children }: { icon: string; title: string; line?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Container layout="vertical" gap="md" className="min-w-0">
      <Container layout="horizontal" wrap alignItems="center" justifyContent="between" gap="sm" className="min-w-0">
        <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0 flex-1 basis-56">
          <IconBox icon={icon} />
          <Container layout="vertical" gap="none" className="min-w-0">
            <Text variant="heading-xs" color="strong">{title}</Text>
            {line && <Text variant="body-xs" color="muted">{line}</Text>}
          </Container>
        </Container>
        {action}
      </Container>
      {children}
    </Container>
  );
}

/** A thing the builder could not read, said as one quiet row with the way to fix it. */
function UnreadRow({ source, onConnect }: { source: DealSource; onConnect: () => void }) {
  const notConnected = source.state === 'not_connected';
  return (
    <ListingCard
      listing={{
        id: source.id, form: 'row', icon: notConnected ? 'PlugZap' : 'CircleAlert', tone: notConnected ? 'info' : 'attention',
        title: notConnected ? `Connect ${source.connection ?? 'your payment service'} to see ${source.label.toLowerCase()}` : `${source.label} could not be read`,
        ...(source.reason ? { text: source.reason } : {}),
        ...(notConnected ? { actions: [{ id: 'connect', label: 'Connect', primary: true }] } : {}),
      }}
      onAction={onConnect}
    />
  );
}

function TemplateModal({ open, templates, onClose, onLoad, onKeep, canKeep }: { open: boolean; templates: ContractTemplate[]; onClose: () => void; onLoad: (templateId: string) => void; onKeep: (name: string) => void; canKeep: boolean }) {
  const [name, setName] = React.useState('');
  const listings = templates.map((template): Listing => {
    const total = template.rules.filter((rule): rule is CommitmentPrimitive => rule.type === 'Commitment').reduce((sum, rule) => sum + commitmentTotal(rule), 0);
    return {
      id: template.id, title: template.name, text: template.description, icon: 'FileText',
      ...(total > 0 ? { value: money(total) } : {}),
      facts: [...new Set(template.rules.map(rule => rule.type))].map(type => ({ label: primitiveInfo(type).title, value: primitiveInfo(type).shortTitle, icon: primitiveInfo(type).icon })),
    };
  });
  return (
    <FloatingPanel open={open} onClose={onClose} title="Start from a template" description="Your saved deals first, then ready-made ones." width={960}>
      <Container layout="vertical" gap="lg">
        <ListingGrid label="Templates" listings={listings} onOpen={onLoad} />
        <Container layout="horizontal" wrap alignItems="end" gap="sm" border="top" className="pt-4">
          <Field label="Keep this deal as a template" className="min-w-[14rem] flex-1">
            <Input value={name} placeholder="Template name" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button variant="secondary" disabled={!canKeep} onClick={() => { onKeep(name); setName(''); }}>
            <NamedIcon name="BookmarkPlus" />
            Keep
          </Button>
        </Container>
      </Container>
    </FloatingPanel>
  );
}

export function SalesContractBuilderSurface({ templates = [], resources = { sources: [] },builder,audienceContent }: { templates?: ContractTemplate[]; resources?: DealResources;builder:SalesBuilderContent;audienceContent:AudienceContent }) {
  return (
    <ToastProvider position="bottom-right">
      <SalesContractBuilderSurfaceContent startingTemplates={templates} resources={resources} builder={builder} audienceContent={audienceContent} />
    </ToastProvider>
  );
}

function SalesContractBuilderSurfaceContent({ startingTemplates, resources,builder,audienceContent }: { startingTemplates: ContractTemplate[]; resources: DealResources;builder:SalesBuilderContent;audienceContent:AudienceContent }) {
  const afterPayment=builder.after_payment,words=builder.words_for;
  const toast = useToastContext();
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const state = url.searchParams.get('payments');
    if (!state) return;
    toast.showSuccess(state === 'connected' ? 'Stripe is ready for your payments.' : 'Finish setting up Stripe before sending a paid deal.');
    url.searchParams.delete('payments');
    url.searchParams.delete('mode');
    replaceWorkspaceAddress(window.history.state, `${url.pathname}${url.search}${url.hash}`);
  }, [toast]);
  const offers = React.useMemo(() => itemsOf(resources, 'offers').map((item): Offer => ({ id: item.id, label: item.label ?? item.id, detail: item.detail, price_cents: item.amount_cents, currency: item.currency, interval: item.interval, interval_count: item.interval_count })), [resources]);
  const customers = React.useMemo(() => itemsOf(resources, 'customers').filter(item => item.email || item.label), [resources]);
  const workflows = React.useMemo(() => itemsOf(resources, 'workflows'), [resources]);
  const afterPaymentSteps = React.useMemo((): AfterPaymentStep[] => [
    ...afterPayment.steps,
    ...(afterPayment.workflow_step?workflows.map((workflow): AfterPaymentStep => ({
      id: workflow.id, label: afterPayment.workflow_step!.label.replace('{label}', workflow.label ?? workflow.id), detail: workflow.detail ?? afterPayment.workflow_step!.detail,
      icon: afterPayment.workflow_step!.icon, on: afterPayment.workflow_step!.on, then: { workflow_id: workflow.id, input: {} },
    })):[]),
  ], [workflows,afterPayment]);

  const [templates, setTemplates] = React.useState<ContractTemplate[]>(startingTemplates);
  const [showTemplates, setShowTemplates] = React.useState(false);
  const [contractName, setContractName] = React.useState(DEFAULT_NAME);
  const [sourceTerms, setSourceTerms] = React.useState<Record<string, unknown> | undefined>();
  const [buyer, setBuyer] = React.useState<Buyer>({ name: '', email: '' });
  const [buyerChoice, setBuyerChoice] = React.useState('');
  const [offerId, setOfferId] = React.useState('');
  const [currency, setCurrency] = React.useState<CurrencyCode>('usd');
  const [primitives, setPrimitives] = React.useState<PrimitiveLineItem[]>([]);
  const [collapsedBlocks, setCollapsedBlocks] = React.useState<Record<string, boolean>>({});
  const [linkScope, setLinkScope] = React.useState<LinkScope>('email');
  const [linkScopeValue, setLinkScopeValue] = React.useState('');
  const [linkExpiresAt, setLinkExpiresAt] = React.useState('');
  const [linkExpiryValid, setLinkExpiryValid] = React.useState(true);
  const [showOtherWays, setShowOtherWays] = React.useState(false);
  const [showNote, setShowNote] = React.useState(false);
  const [sendNote, setSendNote] = React.useState('');
  const [sendTo, setSendTo] = React.useState('one');
  const [chosenSteps, setChosenSteps] = React.useState<string[]>(() => afterPayment.steps.filter(step => step.chosen).map(step => step.id));
  const [sent, setSent] = React.useState<SentSalesContract | null>(null);
  const [activeStep, setActiveStep] = React.useState<BuilderStep>('setup');
  const [showContractData, setShowContractData] = React.useState(false);
  const [startingPaymentSetup, setStartingPaymentSetup] = React.useState(false);
  const shouldAnimate = !useReducedMotion();
  const activeStepIndex = Math.max(0, BUILDER_STEPS.findIndex((step) => step.id === activeStep));
  const previousStep = BUILDER_STEPS[activeStepIndex - 1] ?? null;
  const nextStep = BUILDER_STEPS[activeStepIndex + 1] ?? null;
  const offer = offers.find(item => item.id === offerId) ?? null;
  const firstOffer = offers[0]?.id ?? '';

  const commitmentBlocks = React.useMemo(() => {
    const commitments = primitives.filter((item): item is PrimitiveLineItem & { primitive: CommitmentPrimitive } => item.primitive.type === 'Commitment');
    const others = primitives.filter((item) => item.primitive.type !== 'Commitment');
    const blocks: CommitmentBlock[] = commitments.map((commitment) => ({ id: commitment.clientId, commitment, relatedPrimitives: others.filter((item) => item.primitive.linked_commitment_id === commitment.clientId) }));
    return { blocks, unlinkedPrimitives: others.filter((item) => !item.primitive.linked_commitment_id) };
  }, [primitives]);

  const totalCents = React.useMemo(() => primitives.reduce((sum, item) => (item.primitive.type === 'Commitment' ? sum + commitmentTotal(item.primitive) : sum), 0), [primitives]);
  const firstCommitment = commitmentBlocks.blocks[0]?.commitment.primitive;
  const sendsByEmail = linkScope === 'email';
  const recipient = sendsByEmail ? buyer.email.trim() : linkScopeValue.trim();

  const output = React.useMemo(() => ({
    id: 'contract:draft',
    name: contractName,
    status: 'draft',
    ...(buyer.name || buyer.email ? { buyer: { ...(buyer.id ? { id: buyer.id } : {}), name: buyer.name, email: buyer.email } } : {}),
    ...(offer ? { offer: { id: offer.id, label: offer.label } } : {}),
    total_amount: totalCents,
    currency,
    rules: primitives.map(cleanPrimitiveForOutput),
    ...(sourceTerms ? { agreement_terms: sourceTerms } : {}),
  }), [buyer, contractName, currency, offer, primitives, sourceTerms, totalCents]);

  const updatePrimitive = React.useCallback((clientId: string, patch: Partial<ContractPrimitive>) => {
    setPrimitives((current) => current.map((item) => (item.clientId === clientId ? { ...item, primitive: { ...item.primitive, ...patch } as ContractPrimitive } : item)));
  }, []);

  const updateCommitmentMetadata = React.useCallback((clientId: string, patch: Partial<CommitmentMetadata>) => {
    setPrimitives((current) => current.map((item) => {
      if (item.clientId !== clientId || item.primitive.type !== 'Commitment') return item;
      const metadata = { ...item.primitive.metadata, ...patch };
      return { ...item, primitive: { ...item.primitive, metadata, total_amount: commitmentTotal({ ...item.primitive, metadata }) } };
    }));
  }, []);

  const addPrimitive = (type: PrimitiveType, linkedCommitmentId?: string) => {
    const primitive = defaultPrimitive(type, currency, firstOffer, words, linkedCommitmentId);
    const clientId = type === 'Commitment' ? makeId('commitment') : makeId(type.toLowerCase());
    setPrimitives((current) => [...current, { clientId, primitive }]);
    setActiveStep(type === 'Commitment' ? 'payments' : 'extras');
  };

  const removePrimitive = (clientId: string) => setPrimitives((current) => current.filter((item) => item.clientId !== clientId));
  const removeCommitmentBlock = (blockId: string) => setPrimitives((current) => current.filter((item) => item.clientId !== blockId && item.primitive.linked_commitment_id !== blockId));

  /** Choosing an offer puts its real price on the first payment (or adds one), and names the deal after it. */
  const chooseOffer = (id: string) => {
    const chosen = offers.find(item => item.id === id);
    setOfferId(id);
    if (!chosen) return;
    const offerCurrency = isCurrency(chosen.currency) ? chosen.currency : currency;
    const amount = chosen.price_cents ?? 0;
    const terms = recurrenceOf(chosen);
    setCurrency(offerCurrency);
    setContractName(current => (current === DEFAULT_NAME || offers.some(item => item.label === current) ? chosen.label : current));
    setPrimitives(current => {
      const at = current.findIndex(item => item.primitive.type === 'Commitment');
      const commitment: CommitmentPrimitive = { type: 'Commitment', label: chosen.label, amount, total_amount: amount, currency: offerCurrency, recurrence: terms.recurrence, metadata: terms.metadata };
      if (at < 0) return [{ clientId: makeId('commitment'), primitive: commitment }, ...current];
      return current.map((item, index) => (index === at ? { ...item, primitive: commitment } : item));
    });
    setSent(null);
  };

  /** Choosing a customer fills who it is for and the address it is sent to. */
  const chooseBuyer = (value: string) => {
    setBuyerChoice(value);
    setSent(null);
    if (value === NEW_BUYER) { setBuyer({ name: '', email: '' }); return; }
    const chosen = customers.find(item => item.id === value);
    if (!chosen) return;
    setBuyer({ id: chosen.id, name: chosen.label ?? '', email: chosen.email ?? '' });
    setLinkScope('email');
  };

  const loadTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setContractName(template.name);
    setPrimitives(cloneRulesAsLineItems(template.rules));
    setSourceTerms(template.sourceTerms);
    setShowTemplates(false);
    setSent(null);
    setShowContractData(false);
    setActiveStep('payments');
  };

  const keepTemplate = (name: string) => {
    const template: ContractTemplate = { id: makeId('template'), name: name.trim() || `${contractName} template`, description: `Kept from ${contractName}`, rules: primitives.map((item) => structuredClone(item.primitive) as ContractPrimitive) };
    setTemplates((current) => [template, ...current]);
    toast.showSuccess(`Kept ${template.name}`);
  };

  /** The follow-ups chosen, with their times set from now; a step that writes to them needs their email address. */
  const followUps = () => afterPaymentSteps
    .filter(step => chosenSteps.includes(step.id))
    .filter(step => sendsByEmail || !JSON.stringify(step.then).includes('{to}'))
    .map(step => ({ label: step.label, on: step.on === 'paid' ? 'paid' : { once_at: onceAtFor(step.on) }, then: step.then }));

  const sendDeal = async () => {
    try {
      if (!linkExpiryValid) throw new Error('Complete the link expiry date and time, or clear it.');
      if (!primitives.some(item => item.primitive.type === 'Commitment')) {
        setActiveStep(offers.length ? 'setup' : 'payments');
        throw new Error('Add the price first.');
      }
      if (linkScope !== 'public' && !recipient) throw new Error(sendsByEmail ? 'Add their email address.' : 'Say who can open it.');
      const saved = await saveSalesContract({ ...output, follow_ups: followUps() });
      const expiresAt = linkExpiresAt ? new Date(linkExpiresAt).toISOString() : undefined;
      const answer = await sendSalesContract(sendsByEmail
        ? { contract_id: saved.id, to: recipient, ...(sendNote.trim() ? { note: sendNote.trim() } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) }
        : { contract_id: saved.id, scope: { kind: linkScope, ...(linkScope === 'public' ? {} : { value: recipient }) }, ...(expiresAt ? { expires_at: expiresAt } : {}) });
      setSent(answer);
      // A link not emailed opens the one sharing sheet for the deal: who has it, roles, who else can open it, its link.
      if (!answer.sent_to) openSharing(answer.contract_id, { title: contractName });
      toast.showSuccess(answer.sent_to ? `Sent to ${answer.sent_to}` : 'Deal link ready');
    } catch (error) {
      toast.showError(errorWords(error, 'The deal could not be sent.'));
      throw error;
    }
  };

  const startPaymentSetup = async () => {
    setStartingPaymentSetup(true);
    try {
      await startSellerPaymentConnect();
    } catch (error) {
      setStartingPaymentSetup(false);
      toast.showError(errorWords(error, 'Payments could not be opened.'));
    }
  };

  const updateSchedule = (clientId: string, schedule: PaymentScheduleItem[]) => updateCommitmentMetadata(clientId, { payment_schedule: schedule });

  const generateInstallments = (clientId: string, discountRamp: boolean) => {
    const item = primitives.find((candidate) => candidate.clientId === clientId);
    if (!item || item.primitive.type !== 'Commitment') return;
    const generator = item.primitive.metadata.generator ?? DEFAULT_GENERATOR;
    const count = Math.max(1, generator.count || 1);
    const intervalDays = daysForInterval(generator.interval_count, generator.interval_unit);
    const totalPrincipal = generator.mode === 'total_split' ? generator.total_cents : generator.amount_cents * count;
    const basePayment = generator.apr_percent > 0 ? paymentWithApr(totalPrincipal, generator.apr_percent, count, intervalDays) : Math.round(totalPrincipal / count);
    const schedule: PaymentScheduleItem[] = Array.from({ length: count }, (_, index) => {
      const discount = discountRamp ? Math.min((generator.discount_percent / 100) * (index / Math.max(1, count - 1)), 0.95) : 0;
      return { id: makeId('schedule'), label: index === 0 ? 'Deposit' : `Installment ${index + 1}`, amount_cents: Math.round(basePayment * (1 - discount)), due_days_from_start: generator.start_day + index * intervalDays };
    });
    updateCommitmentMetadata(clientId, { payment_structure: 'installment', payment_schedule: schedule, apr_percent: generator.apr_percent });
    updatePrimitive(clientId, { recurrence: 'custom' } as Partial<ContractPrimitive>);
  };

  const editorArgs = { currency, setCurrency, offers, words, updatePrimitive, updateCommitmentMetadata, updateSchedule, generateInstallments, removePrimitive, shouldAnimate };
  const openConnections = () => openScreen(builder.screens.connect);

  const customerItems: Option[] = [
    ...customers.map(item => ({ value: item.id, label: item.label || item.email || item.id, description: [item.email, item.detail !== item.email ? item.detail : undefined].filter(Boolean).join(' · ') || undefined, icon: 'UserRound' })),
    { value: NEW_BUYER, label: 'Someone new', description: 'Type their name and email', icon: 'UserPlus' },
  ];
  const offerItems: Option[] = offers.map(item => ({ value: item.id, label: item.label, description: [offerPrice(item), item.detail].filter(Boolean).join(' · ') || undefined, icon: 'Tag' }));
  const unread = [...unreadOf(resources, 'customers'), ...unreadOf(resources, 'offers')].filter((source, index, all) => all.findIndex(other => (other.connection ?? other.id) === (source.connection ?? source.id)) === index);

  const summary: Listing = {
    id: 'deal', icon: 'FileSignature', title: contractName || DEFAULT_NAME,
    when: buyer.name || buyer.email || 'No customer yet',
    value: money(totalCents, currency),
    ...(firstCommitment && RECURRENCE_UNITS[firstCommitment.recurrence] ? { unit: RECURRENCE_UNITS[firstCommitment.recurrence] } : {}),
    valueLabel: `${money(totalCents, currency)} ${firstCommitment ? RECURRENCE_LABELS[firstCommitment.recurrence].toLowerCase() : ''}`.trim(),
    badge: sent ? { label: 'Sent', tone: 'good' } : { label: 'Draft', tone: 'quiet' },
    facts: [
      ...(offer ? [{ label: 'Offer', value: offer.label, icon: 'Tag' }] : []),
      ...(firstCommitment ? [{ label: 'Payments', value: firstCommitment.metadata.payment_structure === 'simple' ? RECURRENCE_LABELS[firstCommitment.recurrence] : PAYMENT_STRUCTURE_LABELS[firstCommitment.metadata.payment_structure], icon: 'CalendarClock' }] : []),
      ...(primitives.length > commitmentBlocks.blocks.length ? [{ label: 'Extras', value: `${primitives.length - commitmentBlocks.blocks.length} extras`, icon: 'KeyRound' }] : []),
    ],
    ...(buyer.email ? { chips: [{ label: buyer.name || buyer.email }] } : {}),
  };
  const followUpListings: Listing[] = afterPaymentSteps.filter(step => chosenSteps.includes(step.id)).map(step => {
    const made = sent?.follow_ups?.find(item => item.label.startsWith(step.label));
    return {
      id: step.id, form: 'row', icon: made?.refused ? 'CircleAlert' : made ? 'Check' : step.icon, tone: made?.refused ? 'bad' : made ? 'good' : undefined,
      title: step.label, when: step.on === 'paid' ? 'When they pay' : `In ${step.on.after_days} days`,
      ...(made?.refused ? { text: made.refused } : {}),
    };
  });

  const stepBody = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeStep}
        initial={shouldAnimate ? { opacity: 0, y: 8 } : false}
        animate={shouldAnimate ? { opacity: 1, y: 0 } : undefined}
        exit={shouldAnimate ? { opacity: 0, y: -6 } : undefined}
        transition={{ duration: 0.18 }}
      >
        {activeStep === 'setup' && (
          <Container layout="vertical" gap="xl">
            <Section icon="UserRound" title="Who it is for" line={customers.length ? `${customers.length} of your customers` : 'Add someone new, or connect where your customers are'}>
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
                <SelectField label="Customer" value={buyerChoice} onChange={chooseBuyer} items={customerItems} placeholder="Choose a customer" />
                <SelectField label="Offer" value={offerId} onChange={chooseOffer} items={offerItems.length ? offerItems : [{ value: '', label: 'No offers read yet', disabled: true }]} placeholder={offers.length ? 'Choose what they buy' : 'No offers yet'} />
              </Container>
              {buyerChoice === NEW_BUYER && (
                <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
                  <Field label="Name"><Input value={buyer.name} placeholder="Their name" onChange={(event) => setBuyer(current => ({ ...current, name: event.target.value }))} /></Field>
                  <Field label="Email"><Input type="email" value={buyer.email} placeholder="name@example.com" onChange={(event) => setBuyer(current => ({ ...current, email: event.target.value }))} /></Field>
                </Container>
              )}
              {unread.map(source => <UnreadRow key={source.id} source={source} onConnect={openConnections} />)}
            </Section>
            <Section icon="FilePenLine" title="The deal" line="Its name and the currency it is priced in">
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-[minmax(0,1fr)_12rem]">
                <Field label="Deal name"><Input value={contractName} onChange={(event) => setContractName(event.target.value)} /></Field>
                <SelectField label="Currency" value={currency} onChange={(value) => isCurrency(value) && setCurrency(value)} items={Object.entries(CURRENCIES).map(([code, config]) => ({ value: code, label: `${config.symbol.trim()} ${config.code}` }))} />
              </Container>
            </Section>
          </Container>
        )}

        {activeStep === 'payments' && (
          <Section icon="Banknote" title="Payments" line={commitmentBlocks.blocks.length ? `${commitmentBlocks.blocks.length} payment${commitmentBlocks.blocks.length === 1 ? '' : 's'}` : 'What they pay and when'}
            action={<Button variant="secondary" size="sm" onClick={() => addPrimitive('Commitment')}><NamedIcon name="Plus" size="xs" />Add a payment</Button>}>
            {commitmentBlocks.blocks.length === 0 && (
              <ListingCard listing={{ id: 'no-payment', form: 'row', icon: 'Banknote', tone: 'quiet', title: offers.length ? 'Choose an offer on the Deal step, or add a payment' : 'Add the first payment', actions: [{ id: 'add', label: 'Add a payment', primary: true }] }} onAction={() => addPrimitive('Commitment')} />
            )}
            {commitmentBlocks.blocks.map((block) => {
              const collapsed = collapsedBlocks[block.id] ?? false;
              return (
                <Card key={block.id} variant="nested" padding="none" className="overflow-hidden">
                  <Container layout="horizontal" wrap alignItems="center" justifyContent="between" gap="sm" padding="md" border={collapsed ? 'none' : 'bottom'}>
                    <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0">
                      <IconBox icon="Banknote" />
                      <Container layout="vertical" gap="none" className="min-w-0">
                        <Text variant="heading-xs" color="strong" truncate>{block.commitment.primitive.label || 'Payment'}</Text>
                        <Text variant="body-xs" color="muted" truncate>{commitmentSummary(block)}</Text>
                      </Container>
                    </Container>
                    <Container layout="horizontal" alignItems="center" gap="xs">
                      <Text variant="heading-xs" color="strong" tabular>{money(commitmentTotal(block.commitment.primitive), block.commitment.primitive.currency)}</Text>
                      <Button variant="ghost" size="icon" aria-label={collapsed ? 'Show the payment' : 'Hide the payment'} onClick={() => setCollapsedBlocks((current) => ({ ...current, [block.id]: !collapsed }))}>
                        <NamedIcon name={collapsed ? 'ChevronDown' : 'ChevronUp'} size="sm" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label="Remove the payment" onClick={() => removeCommitmentBlock(block.id)}>
                        <NamedIcon name="Trash2" size="sm" />
                      </Button>
                    </Container>
                  </Container>
                  {!collapsed && <Container padding="md">{renderCommitmentEditor({ ...editorArgs, item: block.commitment })}</Container>}
                </Card>
              );
            })}
          </Section>
        )}

        {activeStep === 'extras' && (
          <Container layout="vertical" gap="xl">
            {commitmentBlocks.blocks.length === 0 && (
              <ListingCard listing={{ id: 'extras-need-payment', form: 'row', icon: 'Banknote', tone: 'quiet', title: 'Extras attach to a payment; add one first', actions: [{ id: 'add', label: 'Add a payment', primary: true }] }} onAction={() => addPrimitive('Commitment')} />
            )}
            {commitmentBlocks.blocks.map((block) => (
              <Section key={block.id} icon="KeyRound" title={`Extras on ${block.commitment.primitive.label || 'the payment'}`} line={block.relatedPrimitives.length ? `${block.relatedPrimitives.length} added` : 'Access, usage, performance payments, fees, licenses'}>
                {block.relatedPrimitives.map((item) => <React.Fragment key={item.clientId}>{renderPrimitiveEditor({ ...editorArgs, item })}</React.Fragment>)}
                <Container layout="grid" gap="sm" className="grid-cols-1 @min-[460px]:grid-cols-2 @min-[760px]:grid-cols-3">
                  {PRIMITIVE_LIBRARY.filter((primitive) => primitive.type !== 'Commitment').map((primitive) => (
                    <Button key={primitive.type} variant="outline" className="h-auto min-h-14 justify-start gap-3 px-3 py-2.5 text-left" onClick={() => addPrimitive(primitive.type, block.id)}>
                      <IconBox icon={primitive.icon} className="size-8" />
                      <Container layout="vertical" gap="none" className="min-w-0">
                        <Text as="span" variant="body" weight="medium" color="strong">{primitive.title}</Text>
                        <Text as="span" variant="caption" color="muted" truncate>{primitive.description}</Text>
                      </Container>
                    </Button>
                  ))}
                </Container>
              </Section>
            ))}
            {commitmentBlocks.unlinkedPrimitives.length > 0 && (
              <Section icon="Unlink" title="Not attached to a payment" line="Kept with the deal as they are">
                {commitmentBlocks.unlinkedPrimitives.map((item) => <React.Fragment key={item.clientId}>{renderPrimitiveEditor({ ...editorArgs, item })}</React.Fragment>)}
              </Section>
            )}
          </Container>
        )}

        {activeStep === 'share' && (
          <Container layout="vertical" gap="xl">
            <SegmentedControl ariaLabel="Who gets it" value={sendTo} onValueChange={setSendTo}
              items={(audienceContent.screen.who??[]).map(item => ({ id: item.id, label: item.label, icon: <NamedIcon name={item.icon} size="xs" /> }))} className="h-10 w-max max-w-full" />
            {sendTo === 'list' ? (
              <SendToAnAudience price={totalCents} currency={currency} note={sendNote} content={audienceContent} screens={builder.screens}
                prepare={async () => {
                  if (!primitives.some(item => item.primitive.type === 'Commitment')) throw new Error('Add the price first.');
                  return (await saveSalesContract({ ...output, follow_ups: followUps() })).id;
                }} />
            ) : (
            <Section icon="Send" title="Send it" line={sendsByEmail ? 'Only this address can open it, after a one-time email code' : LINK_SCOPES.find(scope => scope.value === linkScope)?.description}>
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
                {sendsByEmail ? (
                  <Field label="Their email"><Input type="email" value={buyer.email} placeholder="name@example.com" onChange={(event) => setBuyer(current => ({ ...current, email: event.target.value }))} /></Field>
                ) : linkScope !== 'public' ? (
                  <Field label={linkScope === 'phone' ? 'Phone number' : linkScope === 'private' ? 'Their Trillion name' : 'Access code'}><Input value={linkScopeValue} onChange={(event) => setLinkScopeValue(event.target.value)} /></Field>
                ) : null}
                {showOtherWays && <SelectField label="Who can open it" value={linkScope} onChange={(value) => setLinkScope(value as LinkScope)} items={LINK_SCOPES} />}
              </Container>
              {showNote && sendsByEmail && (
                <Field label="A note to them"><Textarea rows={3} value={sendNote} placeholder="Good talking today. Here is the plan we agreed." onChange={(event) => setSendNote(event.target.value)} /></Field>
              )}
              <Field label="Link expires" hint="Optional. Leave blank to keep it open until you revoke it.">
                <DateTimePicker aria-label="Link expiry" min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000 + 60_000).toISOString().slice(0, 16)} value={linkExpiresAt} onChange={next => setLinkExpiresAt(next ?? '')} onValidityChange={setLinkExpiryValid} />
              </Field>
              <Container layout="horizontal" wrap gap="xs">
                {sendsByEmail && !showNote && <Button variant="ghost" size="sm" onClick={() => setShowNote(true)}><NamedIcon name="MessageSquareText" size="xs" />Add a note</Button>}
                {!showOtherWays && <Button variant="ghost" size="sm" onClick={() => setShowOtherWays(true)}><NamedIcon name="Link" size="xs" />Other ways to share</Button>}
              </Container>
            </Section>
            )}
            <Section icon="Workflow" title="After they pay" line="Runs on your own rules and schedules, set when you send it"
              action={<Button variant="ghost" size="sm" onClick={() => openScreen(builder.screens.automations)}><NamedIcon name="ExternalLink" size="xs" />Your automations</Button>}>
              <ChoiceList label="After they pay" items={afterPaymentSteps.map(step => ({ id: step.id, label: step.label, detail: step.detail, icon: step.icon }))} chosen={chosenSteps}
                onToggle={(id) => setChosenSteps(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))} />
            </Section>
            {sent && (
              <ListingCard
                listing={{ id: 'sent', form: 'row', icon: 'CheckCircle2', tone: 'good', title: sent.sent_to ? `Sent to ${sent.sent_to}` : 'Your deal link is ready', when: sent.address, actions: [{ id: 'open', label: 'Open', icon: 'ExternalLink', primary: true }] }}
                controls={<CopyButton text={sent.address} label="Copy link" copiedLabel="Copied" failedLabel="Copy failed" variant="secondary" size="sm" />}
                onAction={() => window.open(sent.address, '_blank', 'noopener,noreferrer')}
              />
            )}
            <DisclosureSection title="The deal as data" collapsible open={showContractData} onOpenChange={setShowContractData}>
              <SchemaValueView value={output} />
            </DisclosureSection>
          </Container>
        )}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <Container height="full" minHeight="0" overflow="y-auto" className="@container">
      <Container layout="vertical" gap="lg" width="full" marginX="auto" className="max-w-[1180px] p-3 @min-[480px]:p-4 @min-[720px]:p-6">
        <Container layout="horizontal" wrap alignItems="center" justifyContent="between" gap="md">
          <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0">
            <IconBox icon="FileSignature" className="size-10" />
            <Container layout="vertical" gap="none" className="min-w-0">
              <Text variant="heading-lg" color="strong" truncate>{contractName || DEFAULT_NAME}</Text>
              <Text variant="body-xs" color="muted" truncate>{buyer.name || buyer.email ? `For ${buyer.name || buyer.email}` : 'Build a deal from what your business has'}</Text>
            </Container>
          </Container>
          <Container layout="horizontal" wrap gap="xs" justifyContent="end">
            <Button variant="secondary" onClick={startPaymentSetup} disabled={startingPaymentSetup}>
              <NamedIcon name="CreditCard" />
              {startingPaymentSetup ? 'Opening Stripe' : 'Set up payments'}
            </Button>
            <Button variant="secondary" onClick={() => setShowTemplates(true)}>
              <NamedIcon name="LayoutTemplate" />
              Templates
            </Button>
          </Container>
        </Container>

        <Container overflow="x-auto" className="-mx-1 px-1">
          <SegmentedControl
            ariaLabel="Steps"
            value={activeStep}
            onValueChange={(value) => setActiveStep(value as BuilderStep)}
            items={BUILDER_STEPS.map((step, index) => ({ id: step.id, label: `${index + 1}. ${step.title}`, icon: <NamedIcon name={step.icon} size="xs" /> }))}
            className="h-10 w-max"
          />
        </Container>

        <Container layout="grid" gap="lg" className="grid-cols-1 items-start @min-[720px]:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
          <Card variant="surface" padding="none" layout="stack" className="@container order-last min-w-0 gap-6 p-3 @min-[480px]:p-6 @min-[720px]:order-first">
            {stepBody}
            <Container layout="horizontal" wrap alignItems="center" justifyContent="between" gap="sm" border="top" className="pt-4 [&>button]:shrink-0">
              {previousStep ? (
                <Button variant="ghost" onClick={() => setActiveStep(previousStep.id)}><NamedIcon name="ChevronLeft" size="sm" />{previousStep.title}</Button>
              ) : <Container layout="flow" gap="none" />}
              {nextStep ? (
                <Button variant="primary" onClick={() => setActiveStep(nextStep.id)}>Next: {nextStep.title}<NamedIcon name="ChevronRight" size="sm" /></Button>
              ) : sendTo === 'list' ? <Container layout="flow" gap="none" /> : (
                <Button variant="primary" onClick={sendDeal} disabled={!linkExpiryValid}><NamedIcon name="Send" size="sm" />{sendsByEmail ? 'Send deal' : 'Make the link'}</Button>
              )}
            </Container>
          </Card>
          <Container layout="vertical" gap="md" className="order-first min-w-0 @min-[720px]:sticky @min-[720px]:top-4 @min-[720px]:order-last">
            <ListingCard listing={summary} />
            {followUpListings.length > 0 && (
              <Container layout="vertical" gap="xs" className="hidden @min-[720px]:flex">
                <Text variant="label" color="muted">After they pay</Text>
                <ListingGrid label="After they pay" listings={followUpListings} className="gap-1.5" />
              </Container>
            )}
          </Container>
        </Container>
      </Container>

      <TemplateModal open={showTemplates} templates={templates} onClose={() => setShowTemplates(false)} onLoad={loadTemplate} onKeep={keepTemplate} canKeep={primitives.length > 0} />
    </Container>
  );
}

type EditorArgs = {
  words:BuilderWords;
  item: PrimitiveLineItem;
  currency: CurrencyCode;
  setCurrency: (currency: CurrencyCode) => void;
  offers: Offer[];
  updatePrimitive: (clientId: string, patch: Partial<ContractPrimitive>) => void;
  updateCommitmentMetadata: (clientId: string, patch: Partial<CommitmentMetadata>) => void;
  updateSchedule: (clientId: string, schedule: PaymentScheduleItem[]) => void;
  generateInstallments: (clientId: string, discountRamp: boolean) => void;
  removePrimitive: (clientId: string) => void;
  shouldAnimate: boolean;
};

/** What a rule can point at: the person's own offers, plus whatever the rule already names (a template's access). */
function resourceItems(offers: Offer[], current: string): Option[] {
  const items: Option[] = offers.map(offer => ({ value: offer.id, label: offer.label, description: offerPrice(offer) || undefined, icon: 'Tag' }));
  if (current && !offers.some(offer => offer.id === current)) items.unshift({ value: current, label: humanWords(current), icon: 'KeyRound' });
  return items.length ? items : [{ value: '', label: 'Connect your payment service to choose an offer', disabled: true }];
}

const optionsOf = (rows: Array<{ id: string; label: string }>, current: string): Option[] => {
  const items = rows.map(row => ({ value: row.id, label: row.label }));
  return current && !rows.some(row => row.id === current) ? [{ value: current, label: humanWords(current) }, ...items] : items;
};

function renderPrimitiveEditor(args: EditorArgs) {
  const { item } = args;
  const info = primitiveInfo(item.primitive.type);
  return (
    <Card variant="nested" padding="md" layout="stack" className="gap-4">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
        <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0">
          <IconBox icon={info.icon} />
          <Container layout="vertical" gap="none" className="min-w-0">
            <Text variant="heading-xs" color="strong">{info.title}</Text>
            <Text variant="body-xs" color="muted" truncate>{info.description}</Text>
          </Container>
        </Container>
        <Button variant="ghost" size="icon" aria-label={`Remove ${info.title.toLowerCase()}`} onClick={() => args.removePrimitive(item.clientId)}>
          <NamedIcon name="Trash2" size="sm" />
        </Button>
      </Container>
      <Field label="Name on the deal">
        <Input value={item.primitive.label} onChange={(event) => args.updatePrimitive(item.clientId, { label: event.target.value } as Partial<ContractPrimitive>)} />
      </Field>
      {item.primitive.type === 'GrantAccess' && renderGrantAccessEditor(args as EditorArgs & { item: PrimitiveLineItem & { primitive: GrantAccessPrimitive } })}
      {item.primitive.type === 'MeterUsage' && renderMeterUsageEditor(args as EditorArgs & { item: PrimitiveLineItem & { primitive: MeterUsagePrimitive } })}
      {item.primitive.type === 'Royalty' && renderRoyaltyEditor(args as EditorArgs & { item: PrimitiveLineItem & { primitive: RoyaltyPrimitive } })}
      {item.primitive.type === 'TransactionFee' && renderTransactionFeeEditor(args as EditorArgs & { item: PrimitiveLineItem & { primitive: TransactionFeePrimitive } })}
      {item.primitive.type === 'Entitlement' && renderEntitlementEditor(args as EditorArgs & { item: PrimitiveLineItem & { primitive: EntitlementPrimitive } })}
    </Card>
  );
}

function renderCommitmentEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: CommitmentPrimitive } }) {
  const { item, shouldAnimate } = args;
  const primitive = item.primitive;
  const metadata = primitive.metadata;
  const generator = metadata.generator ?? DEFAULT_GENERATOR;
  const patchCommitment = (patch: Partial<CommitmentPrimitive>) => args.updatePrimitive(item.clientId, patch as Partial<ContractPrimitive>);
  const patchGenerator = (patch: Partial<InstallmentGenerator>) => args.updateCommitmentMetadata(item.clientId, { generator: { ...generator, ...patch } });
  const schedule = metadata.payment_schedule ?? [];
  const phases = metadata.pricing_phases ?? [];
  const cleared: Partial<CommitmentMetadata> = { payment_schedule: undefined, pricing_phases: undefined, ongoing_subscription: undefined, generator: undefined, apr_percent: undefined, apr_mode: undefined, grace_period_days: undefined, late_fee_cents: undefined };

  return (
    <Container layout="vertical" gap="lg">
      <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
        <Field label="Name on the deal">
          <Input value={primitive.label} onChange={(event) => patchCommitment({ label: event.target.value })} />
        </Field>
        <SelectField
          label="How they pay"
          value={metadata.payment_structure}
          onChange={(value) => {
            const nextStructure = value as PaymentStructure;
            if (nextStructure === 'simple') {
              args.updateCommitmentMetadata(item.clientId, { ...cleared, payment_structure: 'simple' });
              patchCommitment({ recurrence: 'one_time', total_amount: primitive.amount });
              return;
            }
            if (nextStructure === 'phased') {
              args.updateCommitmentMetadata(item.clientId, { ...cleared, payment_structure: 'phased', pricing_phases: phases.length ? phases : [{ id: makeId('phase'), duration_months: 1, discount_percentage: 25 }] });
              patchCommitment({ recurrence: primitive.recurrence === 'one_time' ? 'monthly' : primitive.recurrence, total_amount: primitive.amount });
              return;
            }
            // An installment schedule is a set number of payments, which cannot start with free days: they are removed
            // here rather than kept hidden and dropped at checkout.
            args.updateCommitmentMetadata(item.clientId, { payment_structure: 'installment', pricing_phases: undefined, payment_schedule: schedule, generator, trial_period_days: undefined });
            patchCommitment({ recurrence: 'custom' });
          }}
          items={[
            { value: 'simple', label: 'One price', description: 'Once, or the same amount each period', icon: 'Banknote' },
            { value: 'phased', label: 'Phased', description: 'A lower price first, then the full one', icon: 'TrendingUp' },
            { value: 'installment', label: 'Installments', description: 'Your own schedule of payments', icon: 'CalendarRange' },
          ]}
        />
      </Container>

      {metadata.payment_structure === 'simple' && (
        <Container layout="grid" gap="md" className="grid-cols-1 @min-[420px]:grid-cols-2 @min-[640px]:grid-cols-3">
          <MoneyInput label="Amount" cents={primitive.amount} currency={primitive.currency} onChange={(amount) => patchCommitment({ amount, total_amount: amount })} />
          <SelectField label="Repeats" value={primitive.recurrence} onChange={(value) => {
            const nextRecurrence = value as CommitmentPrimitive['recurrence'];
            if (nextRecurrence === 'custom') {
              args.updateCommitmentMetadata(item.clientId, { payment_structure: 'installment', payment_schedule: schedule, generator, trial_period_days: undefined });
              patchCommitment({ recurrence: 'custom' });
              return;
            }
            // A payment made once has no free days first; a repeating one keeps them (shown below, carried to checkout).
            args.updateCommitmentMetadata(item.clientId, { ...cleared, payment_structure: 'simple', ...(nextRecurrence === 'one_time' ? { trial_period_days: undefined } : {}) });
            patchCommitment({ recurrence: nextRecurrence, total_amount: primitive.amount });
          }} items={Object.entries(RECURRENCE_LABELS).map(([value, label]) => ({ value, label }))} />
          <SelectField label="Currency" value={primitive.currency} onChange={(value) => {
            if (!isCurrency(value)) return;
            patchCommitment({ currency: value });
            args.setCurrency(value);
          }} items={Object.entries(CURRENCIES).map(([code, config]) => ({ value: code, label: `${config.symbol.trim()} ${config.code}` }))} />
          {primitive.recurrence !== 'one_time' && (
            <NumberField label="Free days first" value={metadata.trial_period_days ?? 0} min={0} onCommit={(value) => args.updateCommitmentMetadata(item.clientId, { trial_period_days: value })} />
          )}
          {primitive.recurrence === 'custom' && (
            <>
              <NumberField label="Every" value={metadata.custom_interval ?? 1} min={1} onCommit={(value) => args.updateCommitmentMetadata(item.clientId, { custom_interval: value })} />
              <SelectField label="Period" value={metadata.custom_interval_unit ?? 'month'} onChange={(value) => args.updateCommitmentMetadata(item.clientId, { custom_interval_unit: value as BillingInterval })} items={Object.entries(BILLING_INTERVALS).map(([value, label]) => ({ value, label }))} />
            </>
          )}
        </Container>
      )}

      {metadata.payment_structure === 'phased' && (
        <Container layout="vertical" gap="md">
          <Container layout="grid" gap="md" className="grid-cols-1 @min-[420px]:grid-cols-2 @min-[640px]:grid-cols-3">
            <MoneyInput label="Full price" cents={primitive.amount} currency={primitive.currency} onChange={(amount) => patchCommitment({ amount, total_amount: amount })} />
            <NumberField label="Free days first" value={metadata.trial_period_days ?? 0} min={0} onCommit={(value) => args.updateCommitmentMetadata(item.clientId, { trial_period_days: value })} />
            <Button variant="secondary" className="self-end" onClick={() => args.updateCommitmentMetadata(item.clientId, { pricing_phases: [...phases, { id: makeId('phase'), duration_months: 1, discount_percentage: 25 }] })}>
              <NamedIcon name="Plus" size="xs" />
              Add a phase
            </Button>
          </Container>
          {phases.map((phase, index) => (
            <Card key={phase.id} variant="nested" padding="md" layout="stack" className="gap-3">
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[560px]:grid-cols-[1fr_1fr_1fr_auto]">
                <NumberField label={`Phase ${index + 1} months`} value={phase.duration_months} min={1} onCommit={(value) => {
                  const next = [...phases];
                  next[index] = { ...phase, duration_months: value };
                  args.updateCommitmentMetadata(item.clientId, { pricing_phases: next });
                }} />
                <NumberField label="Percent off" value={phase.discount_percentage} decimals min={0} onCommit={(value) => {
                  const next = [...phases];
                  next[index] = { ...phase, discount_percentage: value };
                  args.updateCommitmentMetadata(item.clientId, { pricing_phases: next });
                }} />
                <MoneyInput label="Or this price" cents={phase.amount_override_cents} currency={primitive.currency} onChange={(amount) => {
                  const next = [...phases];
                  next[index] = { ...phase, amount_override_cents: amount };
                  args.updateCommitmentMetadata(item.clientId, { pricing_phases: next });
                }} />
                <Button variant="ghost" size="icon" className="self-end" aria-label={`Remove phase ${index + 1}`} onClick={() => args.updateCommitmentMetadata(item.clientId, { pricing_phases: phases.filter((candidate) => candidate.id !== phase.id) })}>
                  <NamedIcon name="Trash2" size="sm" />
                </Button>
              </Container>
              <Text variant="body-xs" color="muted">
                {phase.amount_override_cents ? money(phase.amount_override_cents, primitive.currency) : money(Math.round(primitive.amount * (1 - phase.discount_percentage / 100)), primitive.currency)} for {phase.duration_months} month{phase.duration_months === 1 ? '' : 's'}, then the next phase.
              </Text>
            </Card>
          ))}
        </Container>
      )}

      <AnimatePresence initial={false}>
        {metadata.payment_structure === 'installment' && (
          <motion.div key="installment-editor" className="grid gap-5" variants={shouldAnimate ? COLLAPSE_VARIANTS : undefined} initial={shouldAnimate ? 'hidden' : false} animate={shouldAnimate ? 'visible' : false} exit={shouldAnimate ? 'exit' : undefined}>
            <Container layout="vertical" gap="sm" width="full">
              <Container layout="horizontal" wrap alignItems="center" justifyContent="between" gap="sm">
                <Text variant="heading-xs" color="strong">Installments</Text>
                <Container layout="horizontal" alignItems="center" gap="xs">
                  <Badge variant="neutral">{money(schedule.reduce((sum, row) => sum + row.amount_cents, 0), primitive.currency)}</Badge>
                  {schedule.length > 0 && (
                    <Button variant="ghost" size="icon" onClick={() => args.updateSchedule(item.clientId, [])} aria-label="Clear installments">
                      <NamedIcon name="Trash2" size="sm" />
                    </Button>
                  )}
                </Container>
              </Container>
              <Container layout="vertical" gap="xs" width="full" className="min-w-0">
                <AnimatePresence initial={false} mode="popLayout">
                  {schedule.map((row, index) => (
                    <motion.div key={row.id} custom={index} className="w-full min-w-0" data-testid="installment-row" variants={shouldAnimate ? LIST_ITEM_VARIANTS : undefined} initial={shouldAnimate ? 'hidden' : false} animate={shouldAnimate ? 'visible' : false} exit={shouldAnimate ? 'exit' : undefined} layout={shouldAnimate ? 'position' : false}>
                      <Card variant="nested" padding="sm" className="w-full min-w-0">
                        <Container layout="grid" gap="sm" alignItems="end" className="w-full min-w-0 grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                          <Text variant="body-xs" color="strong" tabular className="pb-2.5">#{index + 1}</Text>
                          <MoneyInput label="Amount" cents={row.amount_cents} currency={primitive.currency} onChange={(amount_cents) => {
                            const next = [...schedule];
                            next[index] = { ...row, amount_cents };
                            args.updateSchedule(item.clientId, next);
                          }} />
                          <NumberField label="Due on day" value={row.due_days_from_start} min={0} onCommit={(due_days_from_start) => {
                            const next = [...schedule];
                            next[index] = { ...row, due_days_from_start };
                            args.updateSchedule(item.clientId, next.sort((a, b) => a.due_days_from_start - b.due_days_from_start));
                          }} />
                          <Button variant="ghost" size="icon" onClick={() => args.updateSchedule(item.clientId, schedule.filter((candidate) => candidate.id !== row.id))} aria-label={`Remove installment ${index + 1}`}>
                            <NamedIcon name="Trash2" size="sm" />
                          </Button>
                        </Container>
                      </Card>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const next = [...schedule];
                          const nextRow = schedule[index + 1];
                          const nextDueDay = nextRow ? row.due_days_from_start + Math.max(1, Math.floor((nextRow.due_days_from_start - row.due_days_from_start) / 2)) : row.due_days_from_start + 30;
                          const nextAmount = nextRow ? Math.round((row.amount_cents + nextRow.amount_cents) / 2) : row.amount_cents;
                          next.splice(index + 1, 0, { id: makeId('schedule'), label: `Installment ${index + 2}`, amount_cents: nextAmount, due_days_from_start: nextDueDay });
                          args.updateSchedule(item.clientId, next.sort((a, b) => a.due_days_from_start - b.due_days_from_start));
                        }}
                        className="my-1 h-7 w-full justify-center border border-dashed border-border"
                      >
                        <NamedIcon name="Plus" size="xs" />
                        Add a payment here
                      </Button>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {schedule.length === 0 && (
                  <Button variant="outline" size="sm" onClick={() => args.updateSchedule(item.clientId, [{ id: makeId('schedule'), label: 'Installment 1', amount_cents: 0, due_days_from_start: 0 }])} className="w-full justify-center border-dashed">
                    <NamedIcon name="Plus" size="xs" />
                    Add the first installment
                  </Button>
                )}
              </Container>
            </Container>

            <Card variant="nested" padding="md" layout="stack" className="w-full gap-4">
              <Container layout="horizontal" wrap alignItems="end" justifyContent="between" gap="sm">
                <Text variant="heading-xs" color="strong">Make the schedule for me</Text>
                <SelectField label="By" value={generator.mode} onChange={(value) => patchGenerator({ mode: value as InstallmentGenerator['mode'] })} className="w-48" items={[{ value: 'per_payment', label: 'Amount per payment' }, { value: 'total_split', label: 'Splitting a total' }]} />
              </Container>
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[360px]:grid-cols-2 @min-[640px]:grid-cols-4">
                <NumberField label="Payments" value={generator.count} min={1} onCommit={(count) => patchGenerator({ count })} />
                <MoneyInput label={generator.mode === 'per_payment' ? 'Each payment' : 'Total to split'} cents={generator.mode === 'per_payment' ? generator.amount_cents : generator.total_cents} currency={primitive.currency} onChange={(amount) => patchGenerator(generator.mode === 'per_payment' ? { amount_cents: amount } : { total_cents: amount })} />
                <NumberField label="Yearly interest %" value={generator.apr_percent} decimals min={0} onCommit={(apr_percent) => patchGenerator({ apr_percent })} />
                <NumberField label="Every" value={generator.interval_count} min={1} onCommit={(interval_count) => patchGenerator({ interval_count })} />
                <SelectField label="Period" value={generator.interval_unit} onChange={(value) => patchGenerator({ interval_unit: value as BillingInterval })} items={Object.entries(BILLING_INTERVALS).map(([value, label]) => ({ value, label }))} />
                <NumberField label="First on day" value={generator.start_day} min={0} onCommit={(start_day) => patchGenerator({ start_day })} />
                <NumberField label="Discount ramp %" value={generator.discount_percent} decimals min={0} onCommit={(discount_percent) => patchGenerator({ discount_percent })} />
              </Container>
              <Container layout="horizontal" wrap gap="xs">
                <Button variant="primary" size="sm" onClick={() => args.generateInstallments(item.clientId, false)}>Make the schedule</Button>
                <Button variant="secondary" size="sm" onClick={() => args.generateInstallments(item.clientId, true)}>With a discount ramp</Button>
                <Button variant="ghost" size="sm" onClick={() => args.updateSchedule(item.clientId, [...schedule, { id: makeId('schedule'), label: `Installment ${schedule.length + 1}`, amount_cents: 0, due_days_from_start: schedule.length ? schedule[schedule.length - 1].due_days_from_start + 30 : 0 }])}>Add one at the end</Button>
              </Container>
            </Card>

            <DisclosureSection title="Late payments and what follows" collapsible defaultOpen={false}>
              <Container layout="grid" gap="md" className="grid-cols-1 @min-[600px]:grid-cols-3">
                <NumberField label="Days of grace" value={metadata.grace_period_days ?? 0} min={0} onCommit={(grace_period_days) => args.updateCommitmentMetadata(item.clientId, { grace_period_days })} />
                <MoneyInput label="Late fee" cents={metadata.late_fee_cents} currency={primitive.currency} onChange={(amount) => args.updateCommitmentMetadata(item.clientId, { late_fee_cents: amount })} />
                <MoneyInput label="Then each month" cents={metadata.ongoing_subscription?.amount_cents ?? 0} currency={primitive.currency} onChange={(amount) => args.updateCommitmentMetadata(item.clientId, {
                  ongoing_subscription: {
                    amount_cents: amount,
                    interval: metadata.ongoing_subscription?.interval ?? 'month',
                    interval_count: metadata.ongoing_subscription?.interval_count ?? 1,
                    start_days_from_contract: metadata.ongoing_subscription?.start_days_from_contract ?? 30,
                  },
                })} />
              </Container>
            </DisclosureSection>
          </motion.div>
        )}
      </AnimatePresence>

      <DisclosureSection title="Price it from your offers" collapsible defaultOpen={false}>
        {args.offers.length === 0 && <Text variant="body-xs" color="muted">Connect your payment service in Connections to add up your offers here.</Text>}
        <Container layout="vertical" gap="xs">
          {args.offers.map((offer) => {
            const selections = metadata.resource_calculator ?? {};
            const selection = selections[offer.id] ?? { selected: false, price_cents: offer.price_cents ?? 0 };
            const updateResourceSelection = (nextSelection: { selected: boolean; price_cents: number }) => {
              const nextSelections = { ...selections, [offer.id]: nextSelection };
              const nextTotal = selectedResourceTotalCents(nextSelections);
              args.updateCommitmentMetadata(item.clientId, { resource_calculator: nextSelections });
              args.updatePrimitive(item.clientId, { amount: nextTotal, total_amount: nextTotal } as Partial<ContractPrimitive>);
            };
            return (
              <Container key={offer.id} layout="grid" gap="sm" alignItems="center" className="grid-cols-[auto_minmax(0,1fr)_9rem]">
                <Button variant={selection.selected ? 'success' : 'outline'} size="icon" aria-label={selection.selected ? `Take ${offer.label} out` : `Add ${offer.label}`} aria-pressed={selection.selected} onClick={() => updateResourceSelection({ ...selection, selected: !selection.selected })}>
                  <NamedIcon name={selection.selected ? 'Check' : 'Plus'} size="sm" />
                </Button>
                <Container layout="vertical" gap="none" className="min-w-0">
                  <Text variant="body" weight="medium" color="strong" truncate>{offer.label}</Text>
                  <Text variant="caption" color="muted" truncate>{offerPrice(offer) || offer.detail}</Text>
                </Container>
                <MoneyInput label="Price" cents={selection.price_cents} currency={primitive.currency} onChange={(amount) => updateResourceSelection({ ...selection, price_cents: amount })} />
              </Container>
            );
          })}
        </Container>
      </DisclosureSection>
    </Container>
  );
}

function renderGrantAccessEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: GrantAccessPrimitive } }) {
  const primitive = args.item.primitive;
  const patch = (patchValue: Partial<GrantAccessPrimitive>) => args.updatePrimitive(args.item.clientId, patchValue as Partial<ContractPrimitive>);
  const rules = primitive.constraint_rules ?? [];
  return (
    <Container layout="vertical" gap="md">
      <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
        <SelectField label="Access to" value={primitive.resource} onChange={(value) => patch({ resource: value })} items={resourceItems(args.offers, primitive.resource)} />
        <SelectField label="For how long" value={primitive.condition} onChange={(value) => patch({ condition: value as AccessCondition })} items={[
          { value: 'lifetime', label: 'For good', description: 'Theirs to keep', icon: 'Infinity' },
          { value: 'time_limited', label: 'For a time', description: 'Days, weeks, months or years', icon: 'Timer' },
          { value: 'usage_based', label: 'For a number of uses', description: 'Ends when they used it up', icon: 'Gauge' },
          { value: 'conditional', label: 'While conditions hold', description: 'Such as while payments are made', icon: 'ListChecks' },
        ]} />
      </Container>
      {primitive.condition === 'time_limited' && (
        <Container layout="grid" gap="md" className="grid-cols-2">
          <NumberField label="How long" value={primitive.duration_amount ?? 30} min={1} onCommit={(duration_amount) => patch({ duration_amount })} />
          <SelectField label="Unit" value={primitive.duration_unit ?? 'days'} onChange={(value) => patch({ duration_unit: value as GrantAccessPrimitive['duration_unit'] })} items={[{ value: 'days', label: 'Days' }, { value: 'weeks', label: 'Weeks' }, { value: 'months', label: 'Months' }, { value: 'years', label: 'Years' }]} />
        </Container>
      )}
      {primitive.condition === 'usage_based' && <NumberField label="How many uses" value={primitive.usage_limit ?? 10} min={1} onCommit={(usage_limit) => patch({ usage_limit })} />}
      {primitive.condition === 'conditional' && (
        <Container layout="vertical" gap="sm">
          {rules.map((rule, index) => (
            <Container key={rule.id} layout="grid" gap="sm" alignItems="end" className="grid-cols-1 @min-[420px]:grid-cols-2 @min-[680px]:grid-cols-[1fr_8rem_1fr_6rem_auto]">
              <SelectField label="When" value={rule.constraint_id} onChange={(value) => { const next = [...rules]; next[index] = { ...rule, constraint_id: value }; patch({ constraint_rules: next }); }} items={optionsOf(args.words.conditions, rule.constraint_id)} />
              <SelectField label="Is" value={rule.operator} onChange={(value) => { const next = [...rules]; next[index] = { ...rule, operator: value as ConstraintOperator }; patch({ constraint_rules: next }); }} items={[
                { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'gte', label: 'at least' }, { value: 'lte', label: 'at most' }, { value: 'gt', label: 'more than' }, { value: 'lt', label: 'less than' }, { value: 'contains', label: 'contains' },
              ]} />
              <Field label="Value"><Input value={rule.value} onChange={(event) => { const next = [...rules]; next[index] = { ...rule, value: event.target.value }; patch({ constraint_rules: next }); }} /></Field>
              <SelectField label="And / or" value={rule.logic_operator} onChange={(value) => { const next = [...rules]; next[index] = { ...rule, logic_operator: value as LogicOperator }; patch({ constraint_rules: next }); }} items={[{ value: 'AND', label: 'And' }, { value: 'OR', label: 'Or' }]} />
              <Button variant="ghost" size="icon" aria-label="Remove the condition" onClick={() => patch({ constraint_rules: rules.filter((candidate) => candidate.id !== rule.id) })}><NamedIcon name="Trash2" size="sm" /></Button>
            </Container>
          ))}
          <Button variant="outline" size="sm" className="self-start" onClick={() => patch({ constraint_rules: [...rules, { id: makeId('constraint-rule'), constraint_id: args.words.conditions[0]?.id ?? '', operator: 'eq', value: 'active', logic_operator: 'AND' }] })}>
            <NamedIcon name="Plus" size="xs" />
            Add a condition
          </Button>
        </Container>
      )}
    </Container>
  );
}

function renderMeterUsageEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: MeterUsagePrimitive } }) {
  const primitive = args.item.primitive;
  const patch = (patchValue: Partial<MeterUsagePrimitive>) => args.updatePrimitive(args.item.clientId, patchValue as Partial<ContractPrimitive>);
  const tiers = primitive.pricing_rules.tiers ?? [];
  return (
    <Container layout="vertical" gap="md">
      <Container layout="grid" gap="md" className="grid-cols-1 @min-[600px]:grid-cols-3">
        <SelectField label="On" value={primitive.resource} onChange={(value) => patch({ resource: value })} items={resourceItems(args.offers, primitive.resource)} />
        <SelectField label="Counted in" value={primitive.metric} onChange={(value) => patch({ metric: value })} items={optionsOf(args.words.metrics, primitive.metric)} />
        <MoneyInput label="Price per unit" cents={primitive.pricing_rules.per_unit_cents} currency={args.currency} onChange={(amount) => patch({ pricing_rules: { ...primitive.pricing_rules, per_unit_cents: amount } })} />
      </Container>
      {tiers.map((tier, index) => (
        <Container key={tier.id} layout="grid" gap="sm" alignItems="end" className="grid-cols-1 @min-[420px]:grid-cols-2 @min-[620px]:grid-cols-[1fr_1fr_1fr_auto]">
          <NumberField label="From" value={tier.min} min={0} onCommit={(min) => { const next = [...tiers]; next[index] = { ...tier, min }; patch({ pricing_rules: { ...primitive.pricing_rules, tiers: next } }); }} />
          <Field label="Up to">
            <Input type="text" inputMode="numeric" value={tier.max ?? ''} placeholder="No limit" onChange={(event) => { const next = [...tiers]; next[index] = { ...tier, max: event.target.value ? Number.parseInt(event.target.value, 10) : undefined }; patch({ pricing_rules: { ...primitive.pricing_rules, tiers: next } }); }} />
          </Field>
          <MoneyInput label="Price" cents={tier.price_cents} currency={args.currency} onChange={(amount) => { const next = [...tiers]; next[index] = { ...tier, price_cents: amount }; patch({ pricing_rules: { ...primitive.pricing_rules, tiers: next } }); }} />
          <Button variant="ghost" size="icon" aria-label="Remove the tier" onClick={() => patch({ pricing_rules: { ...primitive.pricing_rules, tiers: tiers.filter((candidate) => candidate.id !== tier.id) } })}><NamedIcon name="Trash2" size="sm" /></Button>
        </Container>
      ))}
      <Button variant="outline" size="sm" className="self-start" onClick={() => patch({ pricing_rules: { ...primitive.pricing_rules, tiers: [...tiers, { id: makeId('tier'), min: 0, max: undefined, price_cents: primitive.pricing_rules.per_unit_cents }] } })}>
        <NamedIcon name="Plus" size="xs" />
        Add a price tier
      </Button>
    </Container>
  );
}

function renderRoyaltyEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: RoyaltyPrimitive } }) {
  const primitive = args.item.primitive;
  const patch = (patchValue: Partial<RoyaltyPrimitive>) => args.updatePrimitive(args.item.clientId, patchValue as Partial<ContractPrimitive>);
  return (
    <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
      <SelectField label="Paid when" value={primitive.trigger_event} onChange={(value) => patch({ trigger_event: value })} items={optionsOf(args.words.events, primitive.trigger_event)} />
      <Field label="Who gets paid"><Input value={primitive.claimant === 'party:seller' ? 'You' : primitive.claimant} onChange={(event) => patch({ claimant: event.target.value === 'You' ? 'party:seller' : event.target.value })} /></Field>
      <MoneyInput label="Fixed amount" cents={primitive.amount_cents} currency={args.currency} onChange={(amount) => patch({ amount_cents: amount })} />
      <NumberField label="Or a percentage" value={primitive.percentage ?? 0} decimals min={0} onCommit={(percentage) => patch({ percentage })} />
    </Container>
  );
}

function renderTransactionFeeEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: TransactionFeePrimitive } }) {
  const primitive = args.item.primitive;
  const patch = (patchValue: Partial<TransactionFeePrimitive>) => args.updatePrimitive(args.item.clientId, patchValue as Partial<ContractPrimitive>);
  return (
    <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
      <SelectField label="Fee" value={primitive.fee_type} onChange={(value) => patch({ fee_type: value as FeeType })} items={[{ value: 'percentage', label: 'A percentage', icon: 'Percent' }, { value: 'fixed', label: 'A fixed amount', icon: 'Banknote' }]} />
      {primitive.fee_type === 'fixed'
        ? <MoneyInput label="Amount" cents={primitive.fee_amount_cents} currency={args.currency} onChange={(amount) => patch({ fee_amount_cents: amount })} />
        : <NumberField label="Percentage" value={primitive.fee_percentage ?? 0} decimals min={0} onCommit={(fee_percentage) => patch({ fee_percentage })} />}
      <Field label="Paid to"><Input value={primitive.recipient === 'party:seller' ? 'You' : primitive.recipient} onChange={(event) => patch({ recipient: event.target.value === 'You' ? 'party:seller' : event.target.value })} /></Field>
      <SelectField label="On" value={primitive.basis_transaction} onChange={(value) => patch({ basis_transaction: value })} items={optionsOf(args.words.events, primitive.basis_transaction)} />
    </Container>
  );
}

function renderEntitlementEditor(args: EditorArgs & { item: PrimitiveLineItem & { primitive: EntitlementPrimitive } }) {
  const primitive = args.item.primitive;
  const patch = (patchValue: Partial<EntitlementPrimitive>) => args.updatePrimitive(args.item.clientId, patchValue as Partial<ContractPrimitive>);
  return (
    <Container layout="grid" gap="md" className="grid-cols-1 @min-[420px]:grid-cols-2 @min-[720px]:grid-cols-4">
      <Field label="Kind"><Input value={primitive.item_type} onChange={(event) => patch({ item_type: event.target.value })} /></Field>
      <Field label="Name"><Input value={primitive.item_name} onChange={(event) => patch({ item_name: event.target.value })} /></Field>
      <NumberField label="How many" value={primitive.quantity} min={1} onCommit={(quantity) => patch({ quantity })} />
      <SelectField label="Can they pass it on" value={primitive.transferable ? 'true' : 'false'} onChange={(value) => patch({ transferable: value === 'true' })} items={[{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }]} />
    </Container>
  );
}
