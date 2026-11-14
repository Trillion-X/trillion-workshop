'use client';

import React from 'react';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { formatMoneyCents } from '../../../../ui/packages/ui/show/format-money';
import { LoadingOverlay } from '../../../../ui';
import {
  findCheckoutOfferBySelector,
  type CheckoutOffer,
  type CommercialPriceOption,
  type VoluntaryAmountPolicy,
} from '../../../../funnels-and-offers/read-data/read-offers';
import { applyOfferEligibility } from '../../../read-data/offer-eligibility';
import { readHeldAccessRefs, useCheckoutOffers, useEligibilityRows } from '../../../web/src/workspace/checkout-targets';
import { scopeRecordsForObserver } from '../../../../run-experiments/read-data/scope-records';
import type {
  CheckoutConsent,
  CheckoutCustomer,
  CheckoutMaterialResponse,
  CheckoutStartPayload,
  CheckoutStartResponse,
} from '../../../read-data/checkout-contract';
import {
  CheckoutPaymentSlot,
  type CheckoutPaymentSubmitState,
} from './CheckoutPaymentSlot';

export interface CheckoutFlowProps {
  offers?: CheckoutOffer[];
  offerIds?: string[];
  selectedOfferId?: string;
  title?: string;
}

type CheckoutFields = CheckoutCustomer;

export type VoluntaryAmountInputState =
  | { kind: 'unselected' }
  | { kind: 'custom-editing' }
  | { kind: 'invalid' }
  | { kind: 'below-min'; amountCents: number }
  | { kind: 'above-max'; amountCents: number }
  | { kind: 'valid'; amountCents: number };

const NO_SCOPING_ROWS: readonly unknown[] = [];
const CHECKOUT_PREPARE_TARGET = 'checkout.prepare-checkout';
const CHECKOUT_START_TARGET = 'checkout.start-checkout';
const CHECKOUT_COMPLETE_HOSTED_SESSION_TARGET = 'checkout.complete-hosted-session';
const EMPTY_CONSENT: CheckoutConsent = { billing: false, legal: false };
const EMPTY_FIELDS: CheckoutFields = { email: '', firstName: '', lastName: '' };

export function resolvePostPurchaseRoutePath(routePath?: string | null) {
  const declaredRoute = typeof routePath === 'string' ? routePath.trim() : '';
  return declaredRoute || '/';
}

export function completedPaymentTransition(offer: CheckoutOffer | undefined) {
  const declaredRoute = typeof offer?.post_purchase_route_path === 'string'
    ? offer.post_purchase_route_path.trim()
    : '';
  if (offer?.fulfillment_mode === 'payment_record_only' && !declaredRoute) {
    return { status: 'Checkout confirmed and recorded.', destination: null } as const;
  }
  return {
    status: 'Checkout complete. Opening your access...',
    destination: resolvePostPurchaseRoutePath(declaredRoute),
  } as const;
}

/**
 * The price option this checkout is CURRENTLY on, by name.
 *
 * MONEY-SAFETY, and the last place in this file that still picked by position. The
 * old `?? offer.price_options[0]` did two different wrong things under one operator.
 * A NAMED id that no longer matched silently became whichever row a decoder happened
 * to leave first, and that row is exactly the $0 trial in the incident recorded
 * below at the initial-selection effect. With NO id named it used position 0, while
 * that same effect and `chooseOffer` both already defaulted through
 * `offerPriceForDisplay`, so the one rule this file calls its SSOT had a third
 * implementation sitting underneath it.
 *
 * Position is not an authored value here: `CommercialPriceOption` carries no
 * `sort_order` while `CheckoutOffer` has one and is sorted by it, and
 * `readPriceOptions` drops label-less options and assigns `price:${index}` when an id
 * is absent, so an unrelated DATA edit reorders this array.
 *
 * A named id that matches nothing now resolves to nothing. That is fail-closed
 * rather than merely honest: an undefined price makes `checkoutPlanSelected` false,
 * which stops `shouldPrepareCheckoutMaterial` and leaves `checkoutStartPayload` null,
 * so the flow refuses to proceed instead of charging or granting free access against
 * a price nobody chose.
 */
export function selectedPrice(offer: CheckoutOffer | undefined, priceOptionId: string | null) {
  if (!offer) return undefined;
  const options = Array.isArray(offer.price_options) ? offer.price_options : [];
  if (priceOptionId) return options.find((price) => price.id === priceOptionId);
  // An offer carrying no options has nothing to select, and saying so here keeps
  // `offerPriceForDisplay` exactly as it is. It reads `offer.price_options.find`
  // unguarded and throws on such an offer, which a hostile case in this package's
  // money-safety suite found. Repairing the SSOT is the better fix and it belongs to
  // whoever owns that function's contract, not to a change whose whole point is to
  // leave it alone.
  return options.length === 0 ? undefined : offerPriceForDisplay(offer);
}

function voluntaryAmountPolicy(price: CommercialPriceOption | undefined) {
  return price?.voluntary_amount_policy;
}

function defaultVoluntaryAmountChoice(price: CommercialPriceOption | undefined) {
  const suggestedCents = voluntaryAmountPolicy(price)?.suggested_cents[0] ?? null;
  return { customEditing: false, customValue: '', suggestedCents };
}

function effectiveSuggestedVoluntaryAmount(
  choice: { customEditing: boolean; suggestedCents: number | null },
  policy: VoluntaryAmountPolicy | undefined,
) {
  if (!policy || choice.customEditing) return choice.suggestedCents;
  return choice.suggestedCents ?? policy.suggested_cents[0] ?? null;
}

export function voluntaryAmountSubmitLabel(
  amountCents: number,
  price: CommercialPriceOption | undefined,
) {
  if (amountCents === 0) return 'Continue free';
  const amount = formatMoneyCents(amountCents, price?.currency ?? 'usd');
  const recurring = price?.interval === 'month' || price?.payment_timing === 'subscription';
  return `Support at ${amount}${recurring ? '/mo' : ''}`;
}

export function voluntaryAmountPlaceholder(currency: string, amount = 10) {
  const fractionDigits = new Intl.NumberFormat('en-US', {
    currency: currency.toUpperCase(),
    style: 'currency',
  }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
    useGrouping: false,
  }).format(amount);
}

export function parseVoluntaryAmountInput(
  rawValue: string,
  policy: VoluntaryAmountPolicy,
): VoluntaryAmountInputState {
  const value = rawValue.trim();
  if (!value) return { kind: 'custom-editing' };
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return { kind: 'invalid' };
  const [whole, fraction = ''] = value.split('.');
  const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountCents)) return { kind: 'invalid' };
  if (amountCents !== 0 && amountCents < policy.min_cents) {
    return { kind: 'below-min', amountCents };
  }
  if (policy.max_cents != null && amountCents > policy.max_cents) {
    return { kind: 'above-max', amountCents };
  }
  return { kind: 'valid', amountCents };
}

export function voluntaryAmountMessage(
  state: VoluntaryAmountInputState,
  policy: VoluntaryAmountPolicy,
) {
  switch (state.kind) {
    case 'unselected':
      return policy.allow_custom
        ? 'Choose a suggested amount or enter your own.'
        : 'Choose a suggested amount to continue.';
    case 'custom-editing':
      return 'Enter an amount to continue.';
    case 'invalid':
      return 'Enter a valid amount with no more than two decimal places.';
    case 'below-min':
      return `Enter 0 for free, or at least ${formatMoneyCents(policy.min_cents, policy.currency)}.`;
    case 'above-max':
      return policy.max_cents == null
        ? ''
        : `The maximum contribution is ${formatMoneyCents(policy.max_cents, policy.currency)}.`;
    case 'valid':
      return '';
  }
}

export function checkoutMaterialIdentity(input: {
  cadence: string;
  checkoutCode: string;
  customerSelectedAmountCents?: number;
  offerId: string;
  priceOptionId: string;
  voluntary?: boolean;
}) {
  return [
    input.offerId,
    input.priceOptionId,
    input.checkoutCode || 'no-code',
    input.voluntary
      ? input.customerSelectedAmountCents ?? 'no-voluntary-amount'
      : 'fixed-amount',
    input.cadence,
  ].join('|');
}

export function shouldPrepareCheckoutMaterial(input: {
  checkoutCode: string;
  checkoutPlanSelected: boolean;
  paidSelection: boolean;
}) {
  return Boolean(
    input.checkoutPlanSelected &&
    input.checkoutCode,
  );
}

function priceLabel(price: CommercialPriceOption | undefined) {
  return price?.label ?? 'Price unavailable';
}

export function priceAmount(price: CommercialPriceOption | undefined) {
  if (!price) return 'Unavailable';
  // The displayed amount derives from amount_cents — the same field the server
  // quote charges from (checkout-quote.ts) — via the shared money primitive
  // (ui/show/format-money). The label is framing copy only and is used solely
  // when the record carries no numeric amount.
  if (typeof price.amount_cents === 'number' && Number.isFinite(price.amount_cents)) {
    return formatMoneyCents(price.amount_cents, price.currency ?? 'usd');
  }
  return price.label.split(' ')[0] ?? price.label;
}

export function priceSuffix(price: CommercialPriceOption | undefined) {
  if (!price) return '';
  const amount = priceAmount(price);
  if (price.label.startsWith(amount)) return price.label.slice(amount.length).trim();
  // When the label's leading token is a money string that disagrees with
  // amount_cents, drop that token so the numeric amount is never contradicted
  // on screen; keep the rest of the label as framing copy.
  const [firstToken, ...rest] = price.label.split(' ');
  if (firstToken && /^[^\w\s]?[\d.,]+/.test(firstToken)) return rest.join(' ').trim();
  return price.label;
}

export function checkoutPricePresentation(
  price: CommercialPriceOption | undefined,
  selectionIsFree = false,
) {
  if (!price) return { amount: 'Unavailable', detail: 'Price unavailable' };
  if (typeof price.trial_days === 'number' && price.trial_days > 0) {
    const cadence = price.interval ? ` every ${price.interval}` : '';
    return {
      amount: '$0 today',
      detail: `Then ${priceAmount(price)}${cadence} after your ${Math.trunc(price.trial_days)}-day free trial.`,
    };
  }
  return {
    amount: selectionIsFree ? '$0' : priceAmount(price),
    detail: priceSuffix(price) || priceLabel(price),
  };
}

function compareAtLabel(price: CommercialPriceOption | undefined) {
  return price?.compare_at_amount_cents == null ? undefined : price.compare_at_label;
}

function centsLabel(amountCents: string | undefined, currency = 'usd') {
  const amount = Number.parseInt(amountCents ?? '', 10);
  if (!Number.isFinite(amount)) return '$0';
  return new Intl.NumberFormat('en-US', {
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(amount / 100);
}

function isPaidPrice(price: CommercialPriceOption | undefined) {
  return (price?.amount_cents ?? 0) > 0;
}

// The offer's featured price: its first PAID option, else the first option. This
// is the SSOT for BOTH the displayed price AND the default selected price — so a
// paid offer never defaults to a $0/trial row that renders the green "Create free
// access" CTA on a paid product (a money-safety hole).
export function offerPriceForDisplay(offer: CheckoutOffer) {
  return offer.price_options.find(isPaidPrice) ?? offer.price_options[0];
}

function offerPriceDisplayLabel(offer: CheckoutOffer) {
  if (offer.price_options.length <= 1) return priceLabel(offerPriceForDisplay(offer));
  return offer.price_options.map(priceLabel).join(' | ');
}

function checkoutAttemptId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return body.replace(/^0+$/, '') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/**
 * The non-secret "Get My Key" handoff from the marketing site (bitfield.so
 * accountPortalHandoff.ts): which plan the visitor picked (selected_plan_id /
 * public_offer_id, matched against an offer's public_offer_id) and how many
 * active devices they dialed in (active_devices → billable unit count). Read
 * once from the URL; never trusted for price (the quote clamps units to the
 * offer's own floor and the money gate re-verifies).
 */
function readCheckoutHandoff() {
  if (typeof window === 'undefined') return { publicOfferId: null as string | null, activeDevices: null as number | null };
  const params = new URLSearchParams(window.location.search);
  const publicOfferId = (params.get('selected_plan_id') ?? params.get('public_offer_id'))?.trim() || null;
  const rawDevices = params.get('active_devices');
  const parsed = rawDevices ? Number.parseInt(rawDevices, 10) : NaN;
  const activeDevices = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  return { publicOfferId, activeDevices };
}

function createCheckoutAttempt(key = '') {
  return {
    id: checkoutAttemptId(),
    key,
    startedAt: new Date().toISOString().replace('.000Z', 'Z'),
  };
}

function decodeTargetJson<TResponse>(payload: Uint8Array): TResponse {
  const text = new TextDecoder().decode(payload);
  const body = (text.trim() ? JSON.parse(text) : {}) as TResponse & { error?: unknown };
  if (typeof body.error === 'string' && body.error) throw new Error(body.error);
  return body;
}

async function sendCheckoutTarget<TResponse>(target: string, payload: unknown) {
  const reply = await sendRequestToBitfieldTarget({ target, payload });
  return decodeTargetJson<TResponse>(reply.payload);
}

function customerCheckoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /target carrier failed|not configured|environment variable|publicStatus|statusCode/i.test(message)
    ? 'Payment setup is not available. Please try again later.'
    : message;
}

function fieldComplete(fields: CheckoutFields) {
  return Boolean(fields.email.trim() && fields.firstName.trim() && fields.lastName.trim());
}

function consentComplete(consent: CheckoutConsent) {
  return consent.billing && consent.legal;
}

function visibleBenefitItems(offer: CheckoutOffer) {
  return offer.benefits.slice(0, 4);
}

function detailGroups(offer: CheckoutOffer) {
  const groups = offer.curriculum.filter((group) => group.items.length > 0);
  if (groups.length > 0) return groups;
  const remainingBenefits = offer.benefits.slice(4);
  return remainingBenefits.length > 0 ? [{ items: remainingBenefits, label: 'Also included' }] : [];
}

function scopedOfferList(offers: CheckoutOffer[], offerIds: string[] | undefined) {
  // Nobody said which offers this checkout is for, so it shows the ones that
  // are open to anyone who arrives. An offer only ever made by invitation is
  // held back here rather than joining a row of alternatives, because a
  // descending price ladder shown all at once stops reading as a plan to pick
  // and starts reading as a seller bidding against themselves.
  if (offerIds === undefined) {
    return offers.filter((offer) => offer.shown_without_being_named !== false);
  }
  const allowed = new Set(offerIds.filter((id) => typeof id === 'string' && id.trim().length > 0));
  if (allowed.size === 0) return [];
  return offers.filter((offer) => allowed.has(offer.id));
}

export function resolveCheckoutOfferSelection<T extends { id: string }>(
  offers: readonly T[],
  requestedOfferId?: string | null,
): { kind: 'unavailable' } | { kind: 'choice-required' } | { kind: 'selected'; offer: T } {
  const requested = typeof requestedOfferId === 'string' ? requestedOfferId.trim() : '';
  if (requested) {
    const selected = offers.find((offer) => offer.id === requested);
    return selected ? { kind: 'selected', offer: selected } : { kind: 'unavailable' };
  }
  if (offers.length === 0) return { kind: 'unavailable' };
  if (offers.length === 1) return { kind: 'selected', offer: offers[0]! };
  return { kind: 'choice-required' };
}

export function CheckoutFlow({
  offers: explicitOffers,
  offerIds,
  selectedOfferId,
  title = 'Your details',
}: CheckoutFlowProps) {
  if (explicitOffers !== undefined) {
    return (
      <ResolvedCheckoutFlow
        allOffers={scopedOfferList(explicitOffers, offerIds)}
        explicitOffersProvided
        selectedOfferId={selectedOfferId}
        title={title}
      />
    );
  }

  return (
    <ScopedCheckoutFlow
      offerIds={offerIds}
      selectedOfferId={selectedOfferId}
      title={title}
    />
  );
}

function ScopedCheckoutFlow({
  offerIds,
  selectedOfferId,
  title,
}: Omit<CheckoutFlowProps, 'offers'>) {
  const offerProjection = useCheckoutOffers();
  // No row of the Workshop keeps a visitor's selection surfaces for a screen to read, so no observer is resolved here and
  // the offer list is returned unchanged, as the old screen did with no scoping projection.
  const scopingProjection = NO_SCOPING_ROWS;
  const eligibilityProjection = useEligibilityRows();
  // Upsell/downsell eligibility (J06): the signed-in account's held refs from
  // the product-access SSOT door. Anonymous visitor / no session → [] → only
  // requires_held upsells hide; the base catalog is untouched. A refund's
  // negative event shrinks the held set, so eligibility reverses on the next
  // render with zero code (reversible by policy — structural).
  const [heldRefs, setHeldRefs] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    // A read that fails leaves nothing held: only requires_held upsells hide, the base catalog is untouched.
    void readHeldAccessRefs().then((refs) => {
      if (!cancelled) setHeldRefs(refs);
    }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  // Per-observer offer scoping is OWNED by the decision package: checkout hands
  // the offer list, the opaque scoping projection, and the environment's cookie
  // string to the published owner boundary and renders what comes back. It
  // never reads the projection's rows itself. No projection / no observer →
  // the list is returned unchanged. Runs synchronously in the first-render
  // memo, so only the returned offers' bytes are ever produced for this visitor.
  // Eligibility (DATA rules × held refs) composes AFTER observer scoping —
  // both are blind filters over the same offer list.
  const allOffers = React.useMemo(() => {
    const cookieString = typeof document === 'undefined' ? undefined : document.cookie;
    const { records: scoped, decisions } = scopeRecordsForObserver(
      offerProjection ?? [],
      scopingProjection,
      cookieString,
    );
    for (const decision of decisions) {
      console.log(
        `[checkout] offer selection ${decision.surface_address}: winner=${decision.winner_id} hidden=${decision.hidden_ids.join(',')}`,
      );
    }
    const { offers: eligible, decisions: eligibilityDecisions } = applyOfferEligibility(
      scoped,
      heldRefs,
      eligibilityProjection,
    );
    for (const decision of eligibilityDecisions) {
      console.log(
        `[checkout] offer eligibility ${decision.offer_id}: eligible=${decision.eligible} rules=${decision.rule_ids.join(',')}`,
      );
    }
    return eligible;
  }, [offerProjection, scopingProjection, eligibilityProjection, heldRefs]);
  // Route→offer scope from the ONE authority (the funnel, resolved server-side) via
  // the generic `window.__checkoutOffersForThisPage__` env hook injected in the SSR bodyTail
  // (survives hydration). offerIds narrows the visible plan set to what this route
  // sells; selectedOfferId auto-selects the single OTO offer. This REPLACES the deleted
  // per-offer oto_route_path client resolver (L030/L101). Absent (non-checkout page or
  // another app that sets no hook) → full plan list unchanged.
  const routeScope = React.useMemo(() => {
    if (typeof window === 'undefined') return null;
    const s = (window as unknown as {
      __checkoutOffersForThisPage__?: { selectedOfferId?: string | null; offerIds?: string[] };
    }).__checkoutOffersForThisPage__;
    return s && typeof s === 'object' ? s : null;
  }, []);
  const scopedOffers = React.useMemo(() => {
    const ids = routeScope && Array.isArray(routeScope.offerIds) ? routeScope.offerIds : null;
    return scopedOfferList(scopedOfferList(allOffers, ids ?? undefined), offerIds);
  }, [allOffers, routeScope, offerIds]);
  const scopedSelectedOfferId = selectedOfferId
    ?? (routeScope && typeof routeScope.selectedOfferId === 'string' ? routeScope.selectedOfferId : undefined);
  return (
    <ResolvedCheckoutFlow
      allOffers={scopedOffers}
      explicitOffersProvided={false}
      offersResolved={offerProjection != null}
      selectedOfferId={scopedSelectedOfferId}
      title={title ?? 'Your details'}
    />
  );
}

function ResolvedCheckoutFlow({
  allOffers,
  explicitOffersProvided,
  offersResolved = true,
  selectedOfferId,
  title,
}: {
  allOffers: CheckoutOffer[];
  explicitOffersProvided: boolean;
  offersResolved?: boolean;
  selectedOfferId?: string;
  title: string;
}) {
  // Route→offer scope is owned by the ONE authority — the funnel (resolved in the
  // SSR renderer's checkoutForPublicRoute) — and delivered to `allOffers` upstream
  // in ScopedCheckoutFlow via the generic `window.__checkoutOffersForThisPage__` env hook.
  // The old per-offer `oto_route_path` client resolver is DELETED (L030/L101): there
  // is exactly ONE route resolver (the funnel), never a second one here. What remains
  // here is only self-describing SELECTION that is not a route resolver: an explicit
  // selectedOfferId prop, and a `?offer=<id>` URL selector for the generic /checkout.
  const handoff = React.useMemo(readCheckoutHandoff, []);
  const routeSelection = React.useMemo(() => {
    if (selectedOfferId) return { invalid: false, offerId: undefined as string | undefined };
    const query = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('offer')?.trim()
      : '';
    if (query) {
      const matched = findCheckoutOfferBySelector(allOffers, query);
      return matched
        ? { invalid: false, offerId: matched.id }
        : { invalid: true, offerId: undefined };
    }
    // "Get My Key" handoff: match the visitor's chosen plan by the offer's
    // public_offer_id (personal/builder), never by parsing the namespaced id.
    if (handoff.publicOfferId) {
      const byPublic = allOffers.find((offer) => offer.public_offer_id === handoff.publicOfferId);
      return byPublic
        ? { invalid: false, offerId: byPublic.id }
        : { invalid: true, offerId: undefined };
    }
    return { invalid: false, offerId: undefined };
  }, [allOffers, selectedOfferId, handoff.publicOfferId]);

  const offers = React.useMemo(() => {
    // `allOffers` is already route-scoped upstream (ScopedCheckoutFlow applied the
    // env-hook offerIds). A ?offer=<id> selector narrows to that single offer.
    if (routeSelection.invalid) return [];
    if (routeSelection.offerId) return allOffers.filter((offer) => offer.id === routeSelection.offerId);
    return allOffers;
  }, [allOffers, routeSelection]);
  // Loading vs genuinely-empty: the offer data arrives via a live subscription
  // that is empty during cold boot. An empty `allOffers` while UNRESOLVED is
  // "still loading", not "no offers" — never render the empty/free-default form
  // in that window (it would flash "No offers" + a $0 button on a paid page).
  const offersPending = !offersResolved && allOffers.length === 0;
  // The plan PICKER exists to CHOOSE between offers. With 0 or 1 offer there is
  // nothing to choose, so the single auto-selected offer's payment form takes the
  // full width (an OTO page like /founding shows the form inline, no picker). The
  // picker appears only when there are 2+ offers. Data-driven (L069/L090): keyed
  // on offer count, zero per-page code.
  const showPlanPicker = offers.length >= 2;
  const effectiveSelectedOfferId = selectedOfferId ?? routeSelection.offerId;
  const offerSelection = React.useMemo(
    () => resolveCheckoutOfferSelection(offers, effectiveSelectedOfferId),
    [offers, effectiveSelectedOfferId],
  );
  const configuredOffer = offerSelection.kind === 'selected' ? offerSelection.offer : undefined;
  const [selectedOffer, setSelectedOffer] = React.useState<CheckoutOffer | undefined>(configuredOffer);
  const [selectedPriceId, setSelectedPriceId] = React.useState<string | null>(
    configuredOffer ? offerPriceForDisplay(configuredOffer)?.id ?? null : null,
  );
  const [expandedOfferId, setExpandedOfferId] = React.useState<string | null>(null);
  const [checkoutFields, setCheckoutFields] = React.useState<CheckoutFields>(EMPTY_FIELDS);
  const [checkoutConsent, setCheckoutConsent] = React.useState<CheckoutConsent>(EMPTY_CONSENT);
  const [checkoutCode, setCheckoutCode] = React.useState('');
  const [voluntaryAmountChoice, setVoluntaryAmountChoice] = React.useState<{
    customEditing: boolean;
    customValue: string;
    suggestedCents: number | null;
  }>(() => defaultVoluntaryAmountChoice(
    configuredOffer ? offerPriceForDisplay(configuredOffer) : undefined,
  ));
  const [checkoutMaterialState, setCheckoutMaterialState] = React.useState<{
    key: string;
    value: CheckoutMaterialResponse;
  } | null>(null);
  const [checkoutErrorState, setCheckoutErrorState] = React.useState<{ key: string; message: string } | null>(null);
  const [checkoutPreparing, setCheckoutPreparing] = React.useState(false);
  const [freeSubmitting, setFreeSubmitting] = React.useState(false);
  const [paymentSubmitState, setPaymentSubmitState] = React.useState<CheckoutPaymentSubmitState>({
    ready: false,
    submit: null,
    submitting: false,
  });
  const [status, setStatus] = React.useState('');
  const checkoutAttemptRef = React.useRef(createCheckoutAttempt());

  // Hosted-checkout success return: Stripe redirects the paid buyer back to
  // /checkout?checkout=success&session_id=cs_...; verify the session SERVER-SIDE
  // (checkout.complete-hosted-session reads it from Stripe) and grant access, then
  // send them into the app. The session may take a beat to flip to 'complete', so
  // poll a few times before giving up. Runs once on mount.
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') !== 'success') return undefined;
    const sessionId = params.get('session_id')?.trim();
    if (!sessionId) return undefined;
    let disposed = false;
    setStatus('Confirming your payment...');
    void (async () => {
      for (let attempt = 0; attempt < 8 && !disposed; attempt += 1) {
        try {
          const result = await sendCheckoutTarget<{
            completed?: boolean;
            granted?: boolean;
            grantedCount?: number;
            paymentRecorded?: boolean;
            postPurchaseRoutePath?: string;
            status?: string;
          }>(
            CHECKOUT_COMPLETE_HOSTED_SESSION_TARGET,
            { session_id: sessionId },
          );
          if (disposed) return;
          if (
            result?.completed ||
            result?.granted ||
            (result?.status === 'completed' && result?.grantedCount === 0)
          ) {
            if (result.paymentRecorded && !result.postPurchaseRoutePath) {
              setStatus('Payment confirmed and recorded.');
              return;
            }
            setStatus('Payment confirmed. Opening the next page...');
            window.location.assign(resolvePostPurchaseRoutePath(result.postPurchaseRoutePath));
            return;
          }
        } catch (error) {
          if (disposed) return;
          setStatus(customerCheckoutError(error));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!disposed) {
        setStatus('Payment confirmation is still pending. Refresh to check again.');
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  React.useEffect(() => {
    setSelectedOffer(configuredOffer);
    // SSOT: the DEFAULT selected price is the SAME price the offer features for
    // display (offerPriceForDisplay = the paid option, else the first). Selecting
    // price_options[0] blindly meant a paid offer whose first option is a $0/trial
    // row defaulted to `!paidSelection` → the submit button rendered the green
    // "Create free access" CTA on a PAID product (money-safety hole + the stray
    // green button students reported). Using offerPriceForDisplay makes the default
    // CTA the paid "Complete checkout" and keeps shown-price == selected-price.
    setSelectedPriceId(configuredOffer ? offerPriceForDisplay(configuredOffer)?.id ?? null : null);
    setExpandedOfferId(null);
    setVoluntaryAmountChoice(defaultVoluntaryAmountChoice(
      configuredOffer ? offerPriceForDisplay(configuredOffer) : undefined,
    ));
  }, [configuredOffer]);

  const price = selectedPrice(selectedOffer, selectedPriceId);
  const amountPolicy = voluntaryAmountPolicy(price);
  React.useEffect(() => {
    if (voluntaryAmountChoice.customEditing || voluntaryAmountChoice.suggestedCents != null) return;
    const defaultChoice = defaultVoluntaryAmountChoice(price);
    if (defaultChoice.suggestedCents == null) return;
    setVoluntaryAmountChoice(defaultChoice);
  }, [price, voluntaryAmountChoice.customEditing, voluntaryAmountChoice.suggestedCents]);
  const effectiveSuggestedCents = effectiveSuggestedVoluntaryAmount(
    voluntaryAmountChoice,
    amountPolicy,
  );
  const voluntaryAmountState: VoluntaryAmountInputState = amountPolicy
    ? effectiveSuggestedCents != null
      ? effectiveSuggestedCents !== 0
        && effectiveSuggestedCents < amountPolicy.min_cents
        ? { kind: 'below-min', amountCents: effectiveSuggestedCents }
        : amountPolicy.max_cents != null && effectiveSuggestedCents > amountPolicy.max_cents
          ? { kind: 'above-max', amountCents: effectiveSuggestedCents }
          : { kind: 'valid', amountCents: effectiveSuggestedCents }
      : voluntaryAmountChoice.customEditing
        ? parseVoluntaryAmountInput(voluntaryAmountChoice.customValue, amountPolicy)
        : { kind: 'unselected' }
    : { kind: 'unselected' };
  const selectedVoluntaryAmountCents = voluntaryAmountState.kind === 'valid'
    ? voluntaryAmountState.amountCents
    : undefined;
  const voluntaryAmountError = amountPolicy
    ? voluntaryAmountMessage(voluntaryAmountState, amountPolicy)
    : '';
  const paidSelection = amountPolicy
    ? selectedVoluntaryAmountCents !== 0
    : isPaidPrice(price);
  const checkoutPlanSelected = Boolean(selectedOffer && price);
  const normalizedCheckoutCode = checkoutCode.trim();
  const quoteShouldPrepare = shouldPrepareCheckoutMaterial({
    checkoutCode: normalizedCheckoutCode,
    checkoutPlanSelected,
    paidSelection,
  });
  const paymentEntryOffer = quoteShouldPrepare ? selectedOffer : undefined;
  const paymentEntryPrice = quoteShouldPrepare ? price : undefined;
  const checkoutMaterialKey = checkoutMaterialIdentity({
    cadence: price?.interval ?? price?.payment_timing ?? 'one-time',
    checkoutCode: normalizedCheckoutCode,
    customerSelectedAmountCents: selectedVoluntaryAmountCents,
    offerId: selectedOffer?.id ?? 'no-payment-offer',
    priceOptionId: price?.id ?? 'no-payment-price',
    voluntary: Boolean(amountPolicy),
  });
  const checkoutMaterialFresh = checkoutMaterialState?.key === checkoutMaterialKey;
  const checkoutMaterial = checkoutMaterialFresh ? checkoutMaterialState?.value ?? null : null;
  const checkoutError = checkoutErrorState?.key === checkoutMaterialKey ? checkoutErrorState.message : '';
  const appliedAdjustment = checkoutMaterialFresh ? checkoutMaterial?.appliedAdjustment : undefined;
  const materialMakesSelectionFree = Boolean(
    checkoutMaterialFresh &&
    checkoutMaterial?.paymentMode === 'free' &&
    checkoutMaterial.amountDueTodayCents === '0',
  );
  const effectivePaidSelection = Boolean(paidSelection && !materialMakesSelectionFree);
  // Hosted-provider redirect (e.g. Stripe hosted Checkout Session). Every paid
  // flow receives this material from explicit start-checkout, after validation
  // and quote signing. No provider session is created by the preview effect.
  const hostedRedirectUrl = effectivePaidSelection ? (checkoutMaterial?.redirectUrl ?? '') : '';
  const checkoutCustomerComplete = fieldComplete(checkoutFields);
  const checkoutConsentComplete = consentComplete(checkoutConsent);
  const checkoutPaymentEntryReady = Boolean(
    effectivePaidSelection &&
    checkoutCustomerComplete &&
    (!amountPolicy || selectedVoluntaryAmountCents != null),
  );
  const checkoutPaymentReady = Boolean(
    checkoutPaymentEntryReady && checkoutConsentComplete,
  );
  const checkoutStartPayload: CheckoutStartPayload | null = selectedOffer && price ? {
    checkoutAttemptId: checkoutAttemptRef.current.id,
    ...(normalizedCheckoutCode ? { checkoutCode: normalizedCheckoutCode } : {}),
    checkoutStartedAt: checkoutAttemptRef.current.startedAt,
    // The buyer returns to the origin they are on. Sending it makes the provider
    // return URLs correct on every deployment, including a tenant host and a
    // desktop shell, with nothing configured anywhere.
    returnUrlBase: typeof window === 'undefined' ? '' : window.location.origin,
    consent: checkoutConsent,
    customer: checkoutFields,
    offerId: selectedOffer.id,
    priceOptionId: price.id,
    ...(selectedVoluntaryAmountCents == null
      ? {}
      : { customerSelectedAmountCents: selectedVoluntaryAmountCents }),
    ...(handoff.activeDevices == null ? {} : { unitCount: handoff.activeDevices }),
  } : null;
  const freeCheckoutReady = Boolean(!effectivePaidSelection && checkoutStartPayload && checkoutCustomerComplete && checkoutConsentComplete);
  const submitDisabled = effectivePaidSelection
    ? !checkoutPaymentReady ||
      checkoutPreparing ||
      paymentSubmitState.submitting ||
      Boolean(
        checkoutMaterial?.paymentMaterialTarget &&
        !hostedRedirectUrl &&
        (!paymentSubmitState.ready || !paymentSubmitState.submit),
      )
    : !freeCheckoutReady || freeSubmitting;

  React.useEffect(() => {
    if (!paymentEntryOffer || !paymentEntryPrice) {
      setCheckoutPreparing(false);
      return undefined;
    }

    let disposed = false;
    if (checkoutAttemptRef.current.key !== checkoutMaterialKey) {
      checkoutAttemptRef.current = createCheckoutAttempt(checkoutMaterialKey);
    }

    setCheckoutPreparing(true);
    setCheckoutErrorState(null);

    async function prepareCheckoutMaterial() {
      try {
        const body = await sendCheckoutTarget<CheckoutMaterialResponse>(CHECKOUT_PREPARE_TARGET, {
          checkoutAttemptId: checkoutAttemptRef.current.id,
          ...(normalizedCheckoutCode ? { checkoutCode: normalizedCheckoutCode } : {}),
          checkoutStartedAt: checkoutAttemptRef.current.startedAt,
          returnUrlBase: window.location.origin,
          offerId: paymentEntryOffer.id,
          priceOptionId: paymentEntryPrice.id,
          ...(handoff.activeDevices == null ? {} : { unitCount: handoff.activeDevices }),
        });
        if (!disposed) {
          setCheckoutMaterialState({ key: checkoutMaterialKey, value: body });
          // A code that did not apply is NOT fatal: the form loads at full price
          // and we surface the soft reason so the buyer understands (invalid /
          // wrong-plan / no-change). Only shown when they actually typed a code.
          setCheckoutErrorState(
            normalizedCheckoutCode && body.codeNotice
              ? { key: checkoutMaterialKey, message: body.codeNotice }
              : null,
          );
        }
      } catch (error) {
        if (!disposed) {
          setCheckoutMaterialState(null);
          setCheckoutErrorState({ key: checkoutMaterialKey, message: customerCheckoutError(error) });
        }
      } finally {
        if (!disposed) setCheckoutPreparing(false);
      }
    }

    void prepareCheckoutMaterial();

    return () => {
      disposed = true;
    };
  }, [checkoutMaterialKey, normalizedCheckoutCode, paymentEntryOffer, paymentEntryPrice]);

  function chooseOffer(offer: CheckoutOffer) {
    setSelectedOffer(offer);
    setSelectedPriceId(offerPriceForDisplay(offer)?.id ?? null);
    setVoluntaryAmountChoice(defaultVoluntaryAmountChoice(offerPriceForDisplay(offer)));
    setStatus('');
  }

  function choosePriceOption(priceOptionId: string) {
    setSelectedPriceId(priceOptionId);
    setVoluntaryAmountChoice(defaultVoluntaryAmountChoice(
      selectedOffer?.price_options.find((option) => option.id === priceOptionId),
    ));
    setStatus('');
  }

  function toggleDetails(offerId: string) {
    setExpandedOfferId((current) => current === offerId ? null : offerId);
  }

  function setCheckoutField(name: keyof CheckoutFields, value: string) {
    setCheckoutFields((current) => ({ ...current, [name]: value }));
  }

  function setConsentField(name: keyof CheckoutConsent, value: boolean) {
    setCheckoutConsent((current) => ({ ...current, [name]: value }));
  }

  function submitLabel() {
    if (freeSubmitting) return 'Creating access';
    if (checkoutPreparing) return 'Preparing checkout';
    if (paymentSubmitState.submitting) return 'Finishing checkout';
    if (amountPolicy && selectedVoluntaryAmountCents != null) {
      return voluntaryAmountSubmitLabel(selectedVoluntaryAmountCents, price);
    }
    if (!effectivePaidSelection) {
      return selectedOffer?.fulfillment_mode === 'payment_record_only'
        ? 'Complete checkout'
        : 'Create free access';
    }
    if (hostedRedirectUrl) return 'Continue to secure checkout';
    return 'Complete checkout';
  }

  async function startCheckout() {
    if (!selectedOffer || !price) return;
    setStatus('');
    if (!effectivePaidSelection) {
      if (!checkoutStartPayload) return;
      setFreeSubmitting(true);
      try {
        await sendCheckoutTarget<CheckoutStartResponse>(CHECKOUT_START_TARGET, checkoutStartPayload);
        const transition = completedPaymentTransition(selectedOffer);
        setStatus(transition.status);
        if (transition.destination) window.location.assign(transition.destination);
      } catch (error) {
        setStatus('');
        setCheckoutErrorState({
          key: checkoutMaterialKey,
          message: customerCheckoutError(error),
        });
      } finally {
        setFreeSubmitting(false);
      }
      return;
    }
    if (checkoutMaterial?.paymentMaterialTarget && !hostedRedirectUrl) {
      paymentSubmitState.submit?.();
      return;
    }
    if (effectivePaidSelection) {
      if (!checkoutStartPayload || (amountPolicy && selectedVoluntaryAmountCents == null)) return;
      if (checkoutAttemptRef.current.key !== checkoutMaterialKey) {
        checkoutAttemptRef.current = createCheckoutAttempt(checkoutMaterialKey);
      }
      const payload: CheckoutStartPayload = {
        ...checkoutStartPayload,
        checkoutAttemptId: checkoutAttemptRef.current.id,
        checkoutStartedAt: checkoutAttemptRef.current.startedAt,
      };
      setCheckoutPreparing(true);
      setCheckoutErrorState(null);
      setStatus('Preparing secure checkout...');
      try {
        const result = await sendCheckoutTarget<CheckoutStartResponse>(CHECKOUT_START_TARGET, payload);
        setCheckoutMaterialState({ key: checkoutMaterialKey, value: result });
        if (result.redirectUrl) {
          setStatus('Opening secure checkout...');
          if (typeof window !== 'undefined') window.location.assign(result.redirectUrl);
          return;
        }
        if (result.paymentMaterialTarget) {
          setStatus('');
        } else {
          setStatus('');
          setCheckoutErrorState({
            key: checkoutMaterialKey,
            message: 'The payment provider did not return secure payment material. Please try again.',
          });
        }
      } catch (error) {
        setStatus('');
        setCheckoutErrorState({
          key: checkoutMaterialKey,
          message: customerCheckoutError(error),
        });
      } finally {
        setCheckoutPreparing(false);
      }
      return;
    }
  }

  return (
    <section className="pricing-checkout-section" data-package="checkout" data-surface="checkout" id="checkout">
      <style>{`
        .pricing-checkout-section {
          color: var(--text-primary);
          min-height: 100%;
          overflow: auto;
          padding: clamp(1rem, 2.4vw, 2rem);
        }

        .pricing-checkout-card {
          display: grid;
          gap: clamp(1.4rem, 2.8vw, 2.6rem);
          margin-inline: auto;
          max-width: min(100%, 1180px);
          scroll-margin-top: 6.5rem;
          width: 100%;
        }

        .pricing-checkout-layout {
          display: grid;
          gap: clamp(1rem, 2vw, 1.8rem);
          grid-template-columns: minmax(0, 1.1fr) minmax(22rem, 0.9fr);
        }

        .pricing-checkout-panel {
          align-self: stretch;
          background: transparent;
          border: 0;
          min-width: 0;
          padding: 0;
        }

        /* Single-offer (or OTO) checkout: with 0-1 offers there is nothing to
           choose, so the plan picker is not rendered and the payment form takes
           the full width. Data-driven via the component (showPlanPicker), keyed
           on offer count — no per-page code. */
        .pricing-checkout-layout[data-single-offer="true"] {
          grid-template-columns: minmax(0, 1fr);
          /* With one offer there is no plan picker, so the payment form is the
             only column. Without a cap it stretched across the full 1180px card
             — far wider than the sales copy's reading column and visually
             off-centre. Cap it to a comfortable single-column form width and
             centre it so it aligns under the page content above. */
          max-width: min(100%, 40rem);
          margin-inline: auto;
        }

        .pricing-checkout-payment-heading {
          align-items: start;
          display: grid;
          gap: clamp(0.72rem, 1.2vw, 0.95rem);
          grid-template-columns: minmax(0, 1fr);
          margin-bottom: clamp(0.1rem, 0.4vw, 0.32rem);
        }

        .pricing-checkout-payment-title {
          color: var(--text-primary);
          font-size: clamp(1.65rem, 2.4vw, 2.28rem);
          font-weight: 760;
          letter-spacing: -0.068em;
          line-height: 0.94;
          margin: 0;
        }

        .pricing-checkout-payment-subtitle {
          color: var(--text-secondary);
          font-size: clamp(1rem, 1.22vw, 1.12rem);
          font-weight: 700;
          letter-spacing: -0.026em;
          line-height: 1.12;
          margin: 0;
        }

        .pricing-payment-form {
          background: transparent;
          border: 0;
          display: grid;
          gap: clamp(0.72rem, 1.1vw, 0.96rem);
          padding: 0;
          scroll-margin-top: 6.5rem;
        }

        .pricing-payment-field-grid {
          display: grid;
          gap: 0.72rem;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .pricing-payment-label {
          color: color-mix(in srgb, var(--text-primary) 76%, transparent);
          display: grid;
          gap: 0.35rem;
          font-size: clamp(0.86rem, 0.96vw, 0.96rem);
          font-weight: 850;
          letter-spacing: -0.02em;
        }

        .pricing-payment-field {
          background: color-mix(in srgb, var(--text-primary) 7%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 13%, transparent);
          color: var(--text-primary);
          font: inherit;
          font-size: clamp(0.95rem, 1.08vw, 1.06rem);
          font-weight: 760;
          letter-spacing: -0.025em;
          outline: 0;
          padding: 0.9rem 0.95rem;
          transition: border-color 160ms ease, box-shadow 160ms ease;
          width: 100%;
        }

        .pricing-payment-field:focus {
          border-color: color-mix(in srgb, var(--text-primary) 38%, transparent);
          box-shadow: inset 0 0 0 2px var(--text-primary);
        }

        .pricing-payment-field::placeholder {
          color: color-mix(in srgb, var(--text-primary) 43%, transparent);
        }

        .pricing-checkout-selected-price-list,
        .pricing-checkout-consent-list {
          display: grid;
          gap: 0.78rem;
          padding-top: clamp(0.18rem, 0.55vw, 0.42rem);
        }

        .pricing-checkout-selected-price {
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
          color: var(--text-primary);
          cursor: pointer;
          display: grid;
          gap: 0.42rem;
          padding: 0.95rem 1rem;
          text-align: left;
        }

        .pricing-checkout-selected-price[data-selected="true"] {
          box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--text-primary) 32%, transparent);
        }

        .pricing-checkout-voluntary-amount {
          border: 0;
          display: grid;
          gap: 0.72rem;
          margin: 0;
          padding: 0;
        }

        .pricing-checkout-voluntary-amount legend {
          color: color-mix(in srgb, var(--text-primary) 76%, transparent);
          font-size: clamp(0.86rem, 0.96vw, 0.96rem);
          font-weight: 850;
          letter-spacing: -0.02em;
          margin-bottom: 0.12rem;
          padding: 0;
        }

        .pricing-checkout-suggested-amounts {
          display: flex;
          flex-wrap: wrap;
          gap: 0.56rem;
        }

        .pricing-checkout-amount-choice {
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
          color: var(--text-primary);
          cursor: pointer;
          flex: 1 0 7rem;
          font: inherit;
          font-weight: 850;
          min-height: 2.9rem;
          padding: 0.62rem 0.78rem;
          position: relative;
        }

        .pricing-checkout-amount-choice[data-selected="true"] {
          box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--text-primary) 32%, transparent);
        }

        .pricing-checkout-amount-badge {
          background: var(--text-primary);
          color: var(--surface);
          font-size: 0.64rem;
          font-weight: 900;
          letter-spacing: 0.025em;
          line-height: 1;
          padding: 0.3rem 0.42rem;
          pointer-events: none;
          position: absolute;
          right: -0.3rem;
          top: -0.38rem;
        }

        @media (max-width: 44rem) {
          .pricing-checkout-suggested-amounts {
            -webkit-overflow-scrolling: touch;
            flex-wrap: nowrap;
            overflow-x: auto;
            overscroll-behavior-x: contain;
            padding: 0.25rem 0.1rem 0.68rem;
            scroll-snap-type: x proximity;
          }

          .pricing-checkout-amount-choice {
            flex: 0 0 min(52vw, 10rem);
            scroll-snap-align: start;
          }
        }

        .pricing-checkout-custom-amount-row {
          align-items: stretch;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
        }

        .pricing-checkout-currency {
          align-items: center;
          background: color-mix(in srgb, var(--text-primary) 11%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 13%, transparent);
          border-right: 0;
          color: color-mix(in srgb, var(--text-primary) 72%, transparent);
          display: flex;
          font-size: 0.82rem;
          font-weight: 900;
          letter-spacing: 0.08em;
          padding-inline: 0.86rem;
          text-transform: uppercase;
        }

        .pricing-checkout-amount-message {
          color: color-mix(in srgb, var(--text-primary) 62%, transparent);
          font-size: clamp(0.82rem, 0.94vw, 0.92rem);
          font-weight: 740;
          line-height: 1.2;
          margin: 0;
        }

        .pricing-checkout-amount-message[data-state="invalid"],
        .pricing-checkout-amount-message[data-state="below-min"],
        .pricing-checkout-amount-message[data-state="above-max"] {
          color: color-mix(in srgb, var(--color-error) 78%, var(--text-primary) 22%);
        }

        .pricing-checkout-total-row {
          align-items: center;
          border-top: 1px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
          column-gap: 0.78rem;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          padding-top: 0.92rem;
        }

        .pricing-checkout-adjustment {
          align-items: center;
          background: color-mix(in srgb, var(--color-success) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
          color: color-mix(in srgb, var(--color-success) 76%, var(--text-primary) 24%);
          column-gap: 0.72rem;
          display: grid;
          font-size: clamp(0.9rem, 1vw, 1rem);
          font-weight: 820;
          grid-template-columns: minmax(0, 1fr) auto;
          letter-spacing: -0.022em;
          line-height: 1.18;
          padding: 0.82rem 0.92rem;
        }

        .pricing-checkout-adjustment strong {
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
          font-weight: 900;
        }

        .pricing-checkout-total-row > span {
          color: color-mix(in srgb, var(--text-primary) 66%, transparent);
          font-size: clamp(0.86rem, 1vw, 0.98rem);
          font-weight: 850;
        }

        .pricing-checkout-total-row strong,
        .pricing-checkout-selected-price strong {
          color: var(--text-primary);
          font-size: clamp(1.48rem, 2.7vw, 2.42rem);
          font-variant-numeric: tabular-nums;
          font-weight: 900;
          letter-spacing: -0.07em;
          line-height: 0.94;
          text-align: right;
        }

        .pricing-checkout-price-line {
          align-items: baseline;
          display: flex;
          flex-wrap: wrap;
          gap: 0.46rem;
        }

        .pricing-checkout-compare-at {
          color: color-mix(in srgb, var(--text-primary) 44%, transparent);
          font-size: clamp(0.88rem, 1.02vw, 1rem);
          font-variant-numeric: tabular-nums;
          font-weight: 820;
          letter-spacing: -0.028em;
          line-height: 1;
          text-decoration: line-through;
          text-decoration-thickness: 1px;
        }

        .pricing-checkout-selected-price small,
        .pricing-checkout-total-note {
          color: color-mix(in srgb, var(--text-primary) 66%, transparent);
          font-size: clamp(0.94rem, 1.12vw, 1.08rem);
          font-weight: 820;
          letter-spacing: -0.02em;
          line-height: 1.16;
        }

        .pricing-checkout-consent-row {
          align-items: start;
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
          color: color-mix(in srgb, var(--text-primary) 72%, transparent);
          cursor: pointer;
          display: grid;
          font-size: clamp(0.95rem, 1.08vw, 1.05rem);
          font-weight: 720;
          gap: 0.68rem;
          grid-template-columns: auto minmax(0, 1fr);
          letter-spacing: -0.022em;
          line-height: 1.22;
          padding: 0.95rem 1rem;
        }

        .pricing-checkout-consent-row input {
          accent-color: var(--text-primary);
          height: 1.16rem;
          margin: 0.05rem 0 0;
          width: 1.16rem;
        }

        .pricing-provider-payment-slot {
          display: grid;
          gap: clamp(0.88rem, 1.2vw, 1.08rem);
          position: relative;
        }

        .pricing-provider-payment-loading {
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
          color: color-mix(in srgb, var(--text-primary) 66%, transparent);
          font-size: clamp(0.94rem, 1.04vw, 1.02rem);
          font-weight: 780;
          letter-spacing: -0.024em;
          line-height: 1.18;
          margin: 0;
          min-height: clamp(12rem, 18vw, 16rem);
          padding: 0.92rem 1rem;
        }

        .pricing-provider-payment-slot .pricing-provider-payment-loading {
          inset: 0;
          position: absolute;
          z-index: 1;
        }

        .pricing-provider-payment-elements {
          min-height: clamp(12rem, 18vw, 16rem);
          opacity: 0;
          pointer-events: none;
          transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .pricing-provider-payment-elements[data-ready="true"] {
          opacity: 1;
          pointer-events: auto;
        }

        .pricing-checkout-error,
        .pricing-checkout-status {
          background: color-mix(in srgb, var(--color-error) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--color-error) 34%, transparent);
          color: color-mix(in srgb, var(--color-error) 78%, var(--text-primary) 22%);
          font-size: clamp(0.94rem, 1.04vw, 1.02rem);
          font-weight: 780;
          letter-spacing: -0.024em;
          line-height: 1.18;
          margin: 0;
          padding: 0.82rem 0.92rem;
        }

        .pricing-checkout-status {
          background: color-mix(in srgb, var(--color-success) 10%, transparent);
          border-color: color-mix(in srgb, var(--color-success) 34%, transparent);
          color: color-mix(in srgb, var(--color-success) 78%, var(--text-primary) 22%);
        }

        .pricing-checkout-submit {
          background: var(--button-primary-bg);
          border: 0;
          color: var(--button-primary-text);
          cursor: pointer;
          font: inherit;
          font-size: clamp(1.02rem, 1.2vw, 1.14rem);
          font-weight: 850;
          min-height: clamp(3.1rem, 4vw, 3.7rem);
          padding: 0 1rem;
          width: 100%;
        }

        .pricing-checkout-submit:disabled {
          cursor: not-allowed;
          opacity: 0.48;
        }

        .pricing-checkout-license-card {
          --pricing-checkout-disclosure-duration: 420ms;
          --pricing-checkout-disclosure-easing: cubic-bezier(0.16, 1, 0.3, 1);
          background: transparent;
          border: 0;
          display: grid;
          gap: clamp(0.76rem, 1.15vw, 1rem);
          padding: clamp(0.72rem, 1.22vw, 1rem);
        }

        .pricing-checkout-option-heading {
          display: grid;
          gap: 0.24rem;
        }

        .pricing-checkout-option-eyebrow {
          color: color-mix(in srgb, var(--text-primary) 58%, transparent);
          font-size: clamp(0.72rem, 0.86vw, 0.84rem);
          font-weight: 900;
          letter-spacing: 0.12em;
          line-height: 1;
          margin: 0;
          text-transform: uppercase;
        }

        .pricing-checkout-option-title {
          color: var(--text-primary);
          font-size: clamp(1.45rem, 2vw, 2.04rem);
          font-weight: 760;
          letter-spacing: -0.066em;
          line-height: 0.96;
          margin: 0;
        }

        .pricing-checkout-option-stack {
          display: grid;
          gap: 0.56rem;
        }

        .pricing-checkout-option-card {
          background: color-mix(in srgb, var(--surface-base) 91%, transparent);
          border: 0;
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 11%, transparent);
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          overflow: hidden;
          transition: background 180ms ease, box-shadow 180ms ease;
        }

        .pricing-checkout-option-card[data-selected="true"] {
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 10%, transparent);
        }

        .pricing-checkout-option-card:not([data-selected="true"]):has(.pricing-checkout-option-select:hover),
        .pricing-checkout-option-card:not([data-selected="true"]):has(.pricing-checkout-option-select:focus-visible) {
          box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--text-primary) 25%, transparent);
        }

        .pricing-checkout-option-select,
        .pricing-checkout-option-toggle {
          appearance: none;
          background: transparent;
          border: 0;
          color: inherit;
          cursor: pointer;
          font: inherit;
          text-align: left;
          touch-action: manipulation;
        }

        .pricing-checkout-option-select {
          align-items: start;
          display: grid;
          gap: 0.62rem;
          grid-column: 1;
          padding: clamp(0.92rem, 1.24vw, 1.12rem);
          width: 100%;
        }

        .pricing-checkout-option-copy {
          display: grid;
          gap: 0.48rem;
          min-width: 0;
        }

        .pricing-checkout-option-copy strong {
          color: var(--text-primary);
          font-size: clamp(1.02rem, 1.25vw, 1.18rem);
          font-weight: 890;
          letter-spacing: -0.04em;
          line-height: 1.04;
        }

        .pricing-checkout-option-copy small {
          color: color-mix(in srgb, var(--text-primary) 58%, transparent);
          font-size: clamp(0.72rem, 0.88vw, 0.82rem);
          font-weight: 760;
          letter-spacing: -0.022em;
          line-height: 1.16;
        }

        .pricing-checkout-option-price {
          align-items: baseline;
          color: var(--text-primary);
          display: flex;
          flex-wrap: wrap;
          font-size: clamp(0.95rem, 1.14vw, 1.08rem);
          font-variant-numeric: tabular-nums;
          font-weight: 900;
          gap: 0.42rem;
          letter-spacing: -0.045em;
          line-height: 1;
          margin-top: 0.08rem;
          white-space: nowrap;
        }

        .pricing-checkout-option-toggle {
          align-self: start;
          color: color-mix(in srgb, var(--text-primary) 66%, transparent);
          font-size: clamp(0.74rem, 0.88vw, 0.84rem);
          font-weight: 850;
          grid-column: 2;
          grid-row: 1;
          justify-self: end;
          letter-spacing: -0.018em;
          padding: clamp(0.92rem, 1.24vw, 1.12rem);
          text-decoration: underline;
          text-decoration-thickness: 1px;
          text-underline-offset: 0.18em;
          width: max-content;
        }

        .pricing-checkout-option-detail {
          display: grid;
          gap: 0.68rem;
          grid-column: 1 / -1;
          max-height: 0;
          opacity: 0;
          overflow: hidden;
          padding-inline: clamp(0.78rem, 1.12vw, 0.98rem);
          transform: translateY(-0.14rem);
          transition:
            max-height var(--pricing-checkout-disclosure-duration) var(--pricing-checkout-disclosure-easing),
            opacity var(--pricing-checkout-disclosure-duration) var(--pricing-checkout-disclosure-easing),
            padding-bottom var(--pricing-checkout-disclosure-duration) var(--pricing-checkout-disclosure-easing),
            transform var(--pricing-checkout-disclosure-duration) var(--pricing-checkout-disclosure-easing);
        }

        .pricing-checkout-option-detail[data-expanded="true"] {
          max-height: 32rem;
          opacity: 1;
          padding-bottom: clamp(0.78rem, 1.12vw, 0.98rem);
          transform: translateY(0);
        }

        .pricing-feature-list {
          display: grid;
          gap: 0.5rem;
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .pricing-feature-list li {
          align-items: start;
          color: color-mix(in srgb, var(--text-primary) 72%, transparent);
          display: grid;
          font-size: clamp(0.84rem, 0.96vw, 0.94rem);
          font-weight: 740;
          gap: 0.55rem;
          grid-template-columns: auto minmax(0, 1fr);
          letter-spacing: -0.02em;
          line-height: 1.22;
        }

        .pricing-feature-bit {
          background: var(--text-primary);
          display: block;
          height: 0.42rem;
          margin-top: 0.36rem;
          width: 0.42rem;
        }

        .pricing-checkout-detail-group {
          display: grid;
          gap: 0.5rem;
        }

        .pricing-checkout-detail-group strong {
          color: color-mix(in srgb, var(--text-primary) 82%, transparent);
          font-size: clamp(0.82rem, 0.96vw, 0.94rem);
          font-weight: 860;
          letter-spacing: -0.02em;
        }

        @media (max-width: 920px) {
          .pricing-checkout-layout,
          .pricing-payment-field-grid {
            grid-template-columns: 1fr;
          }
          /* When stacked on small screens, you pick the plan FIRST, then fill the
             form — so the plan panel comes before the payment panel. */
          .pricing-checkout-plan-panel { order: -1; }
          .pricing-checkout-payment-panel { order: 0; }
        }
      `}</style>

      {(paymentSubmitState.submitting || status) ? (
        <LoadingOverlay
          title={status || 'Completing your purchase…'}
          subtitle="Securing your access — this takes a few seconds."
        />
      ) : null}

      <div className="pricing-checkout-card" aria-labelledby="pricing-checkout-heading">
        {offersPending ? (
          <p className="pricing-checkout-payment-subtitle" role="status" aria-live="polite">Loading checkout…</p>
        ) : offerSelection.kind === 'unavailable' ? (
          <p className="pricing-checkout-payment-subtitle">No eligible offers are available.</p>
        ) : (
        <div className="pricing-checkout-layout" data-single-offer={showPlanPicker ? undefined : 'true'}>
          <section className="pricing-checkout-panel pricing-checkout-payment-panel" aria-label="Checkout details">
            <div className="pricing-checkout-payment-heading">
              <h2 id="pricing-checkout-heading" className="pricing-checkout-payment-title">{title}</h2>
              <p className="pricing-checkout-payment-subtitle">
                Enter your details, agree to the terms, and continue to payment.
              </p>
            </div>

            <div className="pricing-payment-form">
              <label className="pricing-payment-label">
                <span>Email</span>
                <input
                  autoComplete="email"
                  className="pricing-payment-field"
                  inputMode="email"
                  name="email"
                  onChange={(event) => setCheckoutField('email', event.currentTarget.value)}
                  placeholder="you@example.com"
                  type="email"
                  value={checkoutFields.email}
                />
              </label>

              <div className="pricing-payment-field-grid">
                <label className="pricing-payment-label">
                  <span>First name</span>
                  <input
                    autoComplete="given-name"
                    className="pricing-payment-field"
                    name="firstName"
                    onChange={(event) => setCheckoutField('firstName', event.currentTarget.value)}
                    placeholder="First"
                    type="text"
                    value={checkoutFields.firstName}
                  />
                </label>
                <label className="pricing-payment-label">
                  <span>Last name</span>
                  <input
                    autoComplete="family-name"
                    className="pricing-payment-field"
                    name="lastName"
                    onChange={(event) => setCheckoutField('lastName', event.currentTarget.value)}
                    placeholder="Last"
                    type="text"
                    value={checkoutFields.lastName}
                  />
                </label>
              </div>

              <label className="pricing-payment-label">
                <span>Discount or access code</span>
                <input
                  autoComplete="off"
                  className="pricing-payment-field"
                  inputMode="text"
                  name="checkoutCode"
                  onChange={(event) => setCheckoutCode(event.currentTarget.value)}
                  placeholder="Optional code"
                  type="text"
                  value={checkoutCode}
                />
              </label>

              {selectedOffer?.price_options.length ? (
                <div className="pricing-checkout-selected-price-list" aria-label="Selected price">
                  {selectedOffer.price_options.map((option) => {
                    const presentation = checkoutPricePresentation(
                      option,
                      option.id === price?.id && materialMakesSelectionFree,
                    );
                    return (
                      <button
                        className="pricing-checkout-selected-price"
                        data-selected={option.id === price?.id}
                        key={option.id}
                        onClick={() => choosePriceOption(option.id)}
                        type="button"
                      >
                        <span className="pricing-checkout-price-line">
                          <strong>{presentation.amount}</strong>
                          {compareAtLabel(option) ? (
                            <del className="pricing-checkout-compare-at">{compareAtLabel(option)}</del>
                          ) : null}
                        </span>
                        <small>{presentation.detail}</small>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {amountPolicy ? (
                <fieldset className="pricing-checkout-voluntary-amount">
                  <legend>Choose your contribution</legend>
                  {amountPolicy.suggested_cents.length > 0 ? (
                    <div
                      aria-label="Suggested contribution amounts"
                      className="pricing-checkout-suggested-amounts"
                    >
                      {amountPolicy.suggested_cents.map((amountCents) => (
                        <button
                          aria-pressed={effectiveSuggestedCents === amountCents}
                          className="pricing-checkout-amount-choice"
                          data-highlighted={amountPolicy.highlighted_cents === amountCents ? 'true' : undefined}
                          data-selected={effectiveSuggestedCents === amountCents}
                          key={amountCents}
                          onClick={() => {
                            setVoluntaryAmountChoice({
                              customEditing: false,
                              customValue: '',
                              suggestedCents: amountCents,
                            });
                            setStatus('');
                          }}
                          type="button"
                        >
                          {formatMoneyCents(amountCents, amountPolicy.currency)}
                          {amountPolicy.highlighted_cents === amountCents && amountPolicy.highlight_label ? (
                            <span className="pricing-checkout-amount-badge">{amountPolicy.highlight_label}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {amountPolicy.allow_custom ? (
                    <label className="pricing-payment-label">
                      <span>Custom amount</span>
                      <span className="pricing-checkout-custom-amount-row">
                        <span className="pricing-checkout-currency" aria-hidden="true">
                          {amountPolicy.currency}
                        </span>
                        <input
                          aria-describedby="pricing-checkout-amount-message"
                          aria-invalid={['invalid', 'below-min', 'above-max'].includes(voluntaryAmountState.kind)}
                          autoComplete="off"
                          className="pricing-payment-field"
                          inputMode="decimal"
                          min="0"
                          name="voluntaryAmount"
                          onChange={(event) => {
                            setVoluntaryAmountChoice({
                              customEditing: true,
                              customValue: event.currentTarget.value,
                              suggestedCents: null,
                            });
                            setStatus('');
                          }}
                          placeholder={voluntaryAmountPlaceholder(amountPolicy.currency)}
                          step="0.01"
                          type="text"
                          value={voluntaryAmountChoice.customValue}
                        />
                      </span>
                    </label>
                  ) : null}
                  <p
                    className="pricing-checkout-amount-message"
                    data-state={voluntaryAmountState.kind}
                    id="pricing-checkout-amount-message"
                    role={['invalid', 'below-min', 'above-max'].includes(voluntaryAmountState.kind) ? 'alert' : 'status'}
                  >
                    {voluntaryAmountError || `You selected ${formatMoneyCents(selectedVoluntaryAmountCents ?? 0, amountPolicy.currency)}.`}
                  </p>
                </fieldset>
              ) : null}

              {appliedAdjustment ? (
                <div className="pricing-checkout-adjustment" role="status">
                  <span>{appliedAdjustment.label}</span>
                  <strong>{appliedAdjustment.resultLabel || centsLabel(checkoutMaterial?.amountDueTodayCents, checkoutMaterial?.currency)}</strong>
                </div>
              ) : null}

              {checkoutError ? (
                <p className="pricing-checkout-error" role="alert">
                  {checkoutError}
                </p>
              ) : null}

              {effectivePaidSelection && checkoutMaterial?.paymentMaterialTarget && checkoutStartPayload && !hostedRedirectUrl ? (
                <CheckoutPaymentSlot
                  checkout={checkoutMaterial}
                  checkoutRequest={checkoutStartPayload}
                  customer={checkoutFields}
                  disabled={!checkoutPaymentEntryReady}
                  flat
                  onComplete={() => {
                    const transition = completedPaymentTransition(selectedOffer);
                    setStatus(transition.status);
                    if (transition.destination && typeof window !== 'undefined') {
                      window.location.assign(transition.destination);
                    }
                  }}
                  onSubmitStateChange={setPaymentSubmitState}
                  startTarget={CHECKOUT_START_TARGET}
                />
              ) : null}

              <div className="pricing-checkout-consent-list">
                <label className="pricing-checkout-consent-row">
                  <input
                    checked={checkoutConsent.billing}
                    onChange={(event) => setConsentField('billing', event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>I authorize the selected payment for the chosen plan.</span>
                </label>
                <label className="pricing-checkout-consent-row">
                  <input
                    checked={checkoutConsent.legal}
                    onChange={(event) => setConsentField('legal', event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>I agree to the terms, refund policy, and privacy policy for this checkout.</span>
                </label>
              </div>

              <button
                className="pricing-checkout-submit"
                disabled={submitDisabled}
                onClick={startCheckout}
                type="button"
              >
                {submitLabel()}
              </button>

              {status ? <p className="pricing-checkout-status" role="status">{status}</p> : null}
            </div>
          </section>

          {showPlanPicker ? (
          <aside className="pricing-checkout-panel pricing-checkout-plan-panel" aria-label="Checkout plan selection">
            <div className="pricing-checkout-license-card">
              <div className="pricing-checkout-option-heading">
                <p className="pricing-checkout-option-eyebrow">Selected offer</p>
                <h3 className="pricing-checkout-option-title">
                  {offers.length === 1 ? 'What is included' : selectedOffer ? selectedOffer.label : 'Choose your plan'}
                </h3>
              </div>

              {offers.length === 0 ? (
                <p className="pricing-checkout-payment-subtitle">No offers are published yet.</p>
              ) : (
                <div className="pricing-checkout-option-stack" role="radiogroup" aria-label="Choose your plan">
                  {offers.map((offer) => {
                    const selected = offer.id === selectedOffer?.id;
                    const expanded = expandedOfferId === offer.id;
                    const optionPrice = offerPriceForDisplay(offer);
                    const optionPriceLabel = offerPriceDisplayLabel(offer);
                    const detailId = `pricing-checkout-option-detail-${offer.id.replace(/[^a-z0-9_-]+/gi, '-')}`;
                    const details = detailGroups(offer);

                    return (
                      <div
                        className="pricing-checkout-option-card"
                        data-expanded={expanded}
                        data-selected={selected}
                        key={offer.id}
                      >
                        <button
                          aria-checked={selected}
                          aria-controls={detailId}
                          className="pricing-checkout-option-select"
                          onClick={() => chooseOffer(offer)}
                          role="radio"
                          type="button"
                        >
                          <span className="pricing-checkout-option-copy">
                            <strong>{offer.label}</strong>
                            <small>{offer.summary}</small>
                            <span className="pricing-checkout-option-price">
                              <span>{optionPriceLabel}</span>
                              {compareAtLabel(optionPrice) ? (
                                <del className="pricing-checkout-compare-at">{compareAtLabel(optionPrice)}</del>
                              ) : null}
                            </span>
                          </span>
                        </button>
                        {details.length > 0 ? <button
                          aria-controls={detailId}
                          aria-expanded={expanded}
                          className="pricing-checkout-option-toggle"
                          onClick={() => toggleDetails(offer.id)}
                          type="button"
                        >
                          {expanded ? 'Hide details' : 'Show more'}
                        </button> : null}
                        {details.length > 0 ? <div
                          className="pricing-checkout-option-detail"
                          data-expanded={expanded}
                          id={detailId}
                        >
                          {visibleBenefitItems(offer).length ? (
                            <ul className="pricing-feature-list">
                              {visibleBenefitItems(offer).map((benefit) => (
                                <li key={benefit}>
                                  <span className="pricing-feature-bit" aria-hidden="true" />
                                  <span>{benefit}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {details.map((group) => (
                            <div className="pricing-checkout-detail-group" key={group.label}>
                              <strong>{group.label}</strong>
                              <ul className="pricing-feature-list">
                                {group.items.map((item) => (
                                  <li key={item}>
                                    <span className="pricing-feature-bit" aria-hidden="true" />
                                    <span>{item}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
          ) : null}
        </div>
        )}
      </div>
    </section>
  );
}
