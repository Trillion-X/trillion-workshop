'use client';

// The page's price cards: ONE list of the page's shown offers (DATA `pricing.offers`, in that order), each drawn by ONE card
// renderer. A card's next step comes from its offer's own price option, as the host reports it: a voluntary amount the buyer
// picks, a fixed checkout, or a booking address. Words, features and the look are DATA (`pricing.cards`) and this file.

import React from 'react';
import { SectionShell, TextColumn } from '../../../../ui/show/marketing-page/MarketingPagePrimitives';
import { Text, Container, ShowcaseStrip } from '../../../../ui/show/marketing-page/MarketingPagePrimitives';
import { Button } from '../../../../ui/show/button/Button';
import { LANDING_PRICING_SECTION_ID } from '../../../../ui/show/marketing-page/MarketingPagePrimitives';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import { useProgramLandingData } from './ProgramLandingData';
import { BeforeBookingForm } from './BeforeBookingForm';
import {
  beforeBookingHrefOf,
  offerCardsOfThisPage,
  parsePatronAmount,
  readOfferNextStep,
  type OfferNextStep,
  type PatronAmountState,
} from '../read-data/program-pricing-policy';

type DirectCheckoutRequest = {
  checkoutAttemptId: string;
  checkoutStartedAt: string;
  consent: { billing: boolean; legal: boolean };
  customerSelectedAmountCents?: number;
  offerId: string;
  priceOptionId: string;
  returnUrlBase: string;
};

type DirectCheckoutResult = { redirectUrl?: string; status?: string };

// The page's host starts a checkout: it sets window.__programStartCheckout__ before the page mounts (the host's own address
// for it, such as POST /target/checkout.start-checkout). A page whose host set none says so instead of waiting on nothing.
async function startCheckoutThroughThisHost(_request: DirectCheckoutRequest): Promise<DirectCheckoutResult> {
  throw new Error('Checkout is not connected on this page yet.');
}

declare global {
  interface Window {
    __programStartCheckout__?: (request: DirectCheckoutRequest) => Promise<DirectCheckoutResult>;
    // Told once per page when a price has been on screen, with the offers shown.
    // A host that counts who reached a price supplies it; otherwise it is absent.
    __programReachedPrice__?: (offerIds: string[]) => void;
    // The host's answer for the offers the page names, keyed by offer id: each one's own price option (see readOfferNextStep).
    __programOffersForThisPage__?: Record<string, unknown>;
  }
}

type OfferFeature = { id: string; label: string; showcase: React.ComponentProps<typeof ShowcaseStrip>['items'] };

export type OfferCopy = {
  cadence?: string;
  ctaLabel?: string;
  features: OfferFeature[];
  featured?: boolean;
  footnote?: string;
  minimumLabel?: string;
  modelNote: string;
  planName: string;
};

type ProgramPricing = { heading: string; offers: string[]; cards: Record<string, OfferCopy> };

function formatMoneyCents(amountCents: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    currency: currency.toUpperCase(),
    maximumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    style: 'currency',
  }).format(amountCents / 100);
}

function formatEditableDecimal(amountCents: number, currency: string) {
  const fractionDigits = new Intl.NumberFormat('en-US', {
    currency: currency.toUpperCase(),
    style: 'currency',
  }).resolvedOptions().minimumFractionDigits;
  // Editable values must stay compatible with parsePatronAmount, including
  // contributions above $999 (where NumberFormat inserts a grouping comma).
  return (amountCents / 100).toFixed(fractionDigits);
}

// `instanceId` exists because this section appears TWICE on the page: once
// early, so a reader who is already sold never has to scroll for the price,
// and once at the end after the full argument. Two renders of one component
// would otherwise put the same element id in the document twice. The anchor is
// the same reason: the nav and every call to action point at the canonical
// `#pricing`, so only the instance that claims that name carries it.
// `offerIds` lets a page draw a subset of the listed offers (an article draws its one membership card).
export function ProgramPricingSection({ flatSurfaces, instanceId, embedded = false, offerIds }: { flatSurfaces?: boolean; instanceId?: string; embedded?: boolean; offerIds?: string[] }) {
  const pricing = useProgramLandingData().pricing as ProgramPricing;
  const listed = offerIds ?? pricing.offers;
  const anchorId = instanceId ?? LANDING_PRICING_SECTION_ID;
  const idSuffix = instanceId ? `-${instanceId}` : '';
  const pageOffers = offerCardsOfThisPage(typeof window === 'undefined' ? undefined : window.__programOffersForThisPage__, pricing.offers_now);
  const listedKey = listed.join('|');

  // Someone who had the price on screen and did not buy is what moves a
  // discovered price down, so the host is told once, when at least 40% of the
  // section has been visible.
  React.useEffect(() => {
    const report = window.__programReachedPrice__;
    const section = document.getElementById(anchorId);
    if (!report || !section || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      report(listedKey.split('|'));
    }, { threshold: 0.4 });
    observer.observe(section);
    return () => observer.disconnect();
  }, [anchorId, listedKey]);

  return (
    <SectionShell size="default" paddingY={embedded ? 'compact' : 'default'} id={anchorId} style={embedded ? { padding: 0 } : undefined}>
      <style>{`
        /* Two offers side by side on a wide screen. The grid used to ask for
           this through a utility class the hosted page never compiles, so both
           cards stacked in the left half with the right half empty. The grid
           takes no inline column count: an inline one outranks this rule. */
        @media (min-width: 1024px) {
          .program-pricing-grid:has(> .program-pricing-card + .program-pricing-card) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        .program-pricing-grid > .program-pricing-card { justify-self: center; }
        .program-pricing-card {
          width: min(460px, 100%); border-radius: 22px; padding: 26px 26px 22px;
          border: 1px solid rgba(15,23,42,0.12); background: rgba(255,255,255,0.72);
          box-shadow: 0 18px 50px -22px rgba(15,23,42,0.28);
          align-content: start; align-self: start; display: grid; gap: 16px; min-width: 0;
        }
        .program-pricing-name-row {
          display: grid; gap: 14px; padding-bottom: 18px;
          border-bottom: 1px solid rgba(15,23,42,0.10);
        }
        .program-pricing-name { color: #0f172a; font-family: var(--font-display); font-size: clamp(1.65rem, 2.6vw, 2.35rem); font-weight: 700; letter-spacing: -0.035em; line-height: 1.05; }
        .program-pricing-price-row { align-items: baseline; display: flex; flex-wrap: wrap; gap: 6px; }
        .program-pricing-price { color: #0f172a; font-family: var(--font-display); font-size: clamp(2.3rem, 4vw, 3.6rem); font-weight: 700; letter-spacing: -0.045em; line-height: 1; }
        .program-pricing-cadence { color: rgba(15,23,42,0.55); font-size: 0.95rem; font-weight: 650; letter-spacing: 0; }
        .program-pricing-model {
          font-size: 1.08rem; font-weight: 730; color: rgba(15,23,42,0.86); line-height: 1.45;
          background: rgba(0,134,82,0.08); border: 1px solid rgba(0,134,82,0.25);
          border-radius: 14px; padding: 14px 16px; text-align: left;
        }
        .program-pricing-tier-rail {
          display: flex; flex-wrap: wrap; gap: 10px; padding-top: 8px;
        }
        .program-pricing-tier {
          flex: 1 0 calc(25% - 6px); min-width: 7rem; position: relative;
        }
        .program-pricing-tier-badge {
          background: #008652; border-radius: 6px; color: #fff;
          font-size: 0.5625rem; font-weight: 800; letter-spacing: 0.07em; line-height: 1;
          padding: 3px 7px; pointer-events: none; position: absolute; left: 50%; top: -8px;
          transform: translate(-50%, -100%); text-transform: uppercase; white-space: nowrap; z-index: 2;
        }
        @media (max-width: 767px) {
          .program-pricing-card { padding: 20px 16px 18px; width: 100%; }
          .program-pricing-model { font-size: 1rem; line-height: 1.5; padding: 12px 14px 36px; }
          .program-pricing-name { font-size: clamp(1.7rem, 8vw, 2.2rem); }
          .program-pricing-price { font-size: clamp(2.45rem, 12vw, 3.3rem); overflow-wrap: anywhere; }
          .program-pricing-tier-rail {
            flex-wrap: wrap; overflow: visible; padding: 4px 0 0; row-gap: 8px;
          }
          .program-pricing-tier {
            flex: 1 1 calc(50% - 4px); min-width: 0;
          }
          .program-pricing-showcase { overflow: hidden; }
        }
        .program-pricing-features { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
        .program-pricing-features li {
          align-items: flex-start; border-top: 1px solid rgba(15,23,42,0.09); display: grid;
          column-gap: 0.8rem; row-gap: 14px; grid-template-columns: auto minmax(0, 1fr); padding: 18px 0;
        }
        .program-pricing-features li:first-child { border-top: 0; padding-top: 4px; }
        .program-pricing-bit {
          align-items: center; background: #0f172a; border-radius: 999px; color: #fff; display: inline-flex;
          flex: 0 0 auto; font-size: 0.72rem; font-weight: 900; height: 1.45rem; justify-content: center;
          margin-top: 0.08rem; width: 1.45rem;
        }
        .program-pricing-feature-label { color: #172033; display: block; font-size: 1.08rem; font-weight: 680; letter-spacing: -0.012em; line-height: 1.48; }
        .program-pricing-showcase {
          grid-column: 1 / -1;
          min-width: 0;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent);
        }
        .program-booking-form { display: grid; gap: 12px; margin-top: 8px; }
        .program-booking-field { display: grid; gap: 6px; font-size: 15px; line-height: 1.5; }
        .program-booking-field input { border: 1px solid rgba(15,23,42,.14); border-radius: 12px; padding: 10px 12px; font: inherit; background: transparent; }
        .program-pricing-footnote { text-align: center; letter-spacing: -0.01em; }
        .program-pricing-choices { border: 0; margin: 0; min-width: 0; padding: 0; }
        .program-pricing-choices legend { padding: 0 0 4px; }
        .program-pricing-custom { display: grid; gap: 8px; font-size: 15px; font-weight: 700; line-height: 1.5; margin-top: 12px; min-width: 0; }
        .program-pricing-custom-input-row { align-items: stretch; display: grid; grid-template-columns: auto minmax(0, 1fr); min-width: 0; }
        .program-pricing-currency { align-items: center; border: 1px solid rgba(15,23,42,0.25); border-right: 0; display: flex; font-size: 13px; padding: 0 10px; text-transform: uppercase; }
        .program-pricing-custom-input { background: rgba(255,255,255,0.5); border: 1px solid rgba(15,23,42,0.25); box-sizing: border-box; font: inherit; min-height: 44px; min-width: 0; padding: 8px 10px; width: 100%; }
        .program-pricing-more { display: grid; gap: 12px; }
        .program-pricing-more-toggle { justify-self: center; }
      `}</style>
      {!embedded ? <TextColumn measure="hero" align="center" className="gap-3 mb-10 md:mb-12">
        <Text
          as="h2"
          className="program-heading"
          style={{ ...PROGRAM_HERO_ENGRAVED_HEADING_STYLE, textAlign: 'center' }}
          variant="heading-2xl"
          data-testid="program-pricing-conviction"
        >
          {pricing.heading}
        </Text>
      </TextColumn> : null}
      <Container
        layout="grid"
        gap="xl"
        width="full"
        maxWidth="5xl"
        className="mx-auto program-pricing-grid"
        alignItems="stretch"
      >
        {listed.map((offerId) => (
          <OfferCard
            key={offerId}
            card={pageOffers[offerId]}
            copy={pricing.cards[offerId]}
            flatSurfaces={flatSurfaces}
            idSuffix={idSuffix}
            offerId={offerId}
          />
        ))}
      </Container>
    </SectionShell>
  );
}

// The one price card. Its next step is read from the offer's price option; the words come from `pricing.cards[offerId]`.
function OfferCard({ offerId, copy, card, idSuffix, flatSurfaces }: {
  card: unknown;
  copy: OfferCopy;
  flatSurfaces?: boolean;
  idSuffix: string;
  offerId: string;
}) {
  const next: OfferNextStep | null = readOfferNextStep(card, offerId);
  const beforeBooking = beforeBookingHrefOf(useProgramLandingData().pricing.before_booking_path, offerId);
  const policy = next?.kind === 'voluntary' ? next.policy : null;
  const nameId = `program-offer-${offerId.replace(/[^a-zA-Z0-9]+/g, '-')}-name${idSuffix}`;
  const [customEditing, setCustomEditing] = React.useState(false);
  const [showMoreAmounts, setShowMoreAmounts] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const [selectedCents, setSelectedCents] = React.useState<number | null>(policy?.minCents ?? null);
  const [opening, setOpening] = React.useState(false);
  const [checkoutError, setCheckoutError] = React.useState<string | null>(null);

  // The direct no-friction pay path: pay click -> start-checkout -> the provider's
  // own hosted page. NO interstitial form ever sits between intent and Stripe
  // (Stripe collects the buyer's email/name; consent is asserted by the labeled
  // pay click itself). Failure renders inline on the card; the button returns.
  async function startCheckout(selection: { priceOptionId: string; customerSelectedAmountCents?: number }) {
    const sender = window.__programStartCheckout__ ?? startCheckoutThroughThisHost;
    if (opening) return;
    setCheckoutError(null);
    setOpening(true);
    try {
      const result = await sender({
        checkoutAttemptId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `program-${Date.now()}`,
        checkoutStartedAt: new Date().toISOString(),
        consent: { billing: true, legal: true },
        ...(selection.customerSelectedAmountCents == null ? {} : { customerSelectedAmountCents: selection.customerSelectedAmountCents }),
        offerId,
        priceOptionId: selection.priceOptionId,
        returnUrlBase: window.location.origin,
      });
      if (!result.redirectUrl || !/^https:\/\/checkout\.stripe\.com\//.test(result.redirectUrl)) {
        throw new Error('Checkout did not return a valid payment destination. Please try again.');
      }
      window.location.assign(result.redirectUrl);
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : 'Checkout could not start. Please try again.');
      setOpening(false);
    }
  }

  const customState: PatronAmountState | null = !policy
    ? null
    : customEditing
      ? parsePatronAmount(customValue, policy.minCents, policy.maxCents)
      : selectedCents == null
        ? { kind: 'editing' }
        : { kind: 'valid', amountCents: selectedCents };
  const validAmountCents = customState?.kind === 'valid' ? customState.amountCents : null;
  const invalidAmount = customState?.kind === 'invalid'
    || customState?.kind === 'below-min'
    || customState?.kind === 'above-max';
  const currency = policy?.currency ?? (next?.kind === 'checkout' ? next.currency : 'usd');
  const shownAmountCents = next?.kind === 'checkout' ? next.amountCents : validAmountCents;
  const amountMessage = !policy || !customState
    ? ''
    : customState.kind === 'editing'
      ? 'Enter an amount to continue.'
      : customState.kind === 'invalid' || customState.kind === 'below-min'
        ? `${copy.minimumLabel ?? 'Starts at'} ${formatMoneyCents(policy.minCents, policy.currency)}${copy.cadence ?? ''}.`
        : customState.kind === 'above-max' && policy.maxCents != null
          ? `The maximum contribution is ${formatMoneyCents(policy.maxCents, policy.currency)}.`
          : `You selected ${formatMoneyCents(customState.amountCents, policy.currency)}.`;
  const ctaText = validAmountCents == null
    ? 'Enter an amount'
    : `Checkout · ${formatMoneyCents(validAmountCents, currency)}${copy.cadence ?? ''}`;

  function chooseSuggestedAmount(amountCents: number) {
    setCustomEditing(false);
    setSelectedCents(amountCents);
  }

  function toggleMoreAmounts() {
    if (showMoreAmounts && customEditing) {
      setSelectedCents(validAmountCents ?? policy?.minCents ?? null);
      setCustomEditing(false);
    }
    setShowMoreAmounts((shown) => !shown);
  }

  function startPayment() {
    if (!next) return;
    if (next.kind === 'checkout') {
      void startCheckout({ priceOptionId: next.priceOptionId });
      return;
    }
    if (next.kind === 'voluntary' && validAmountCents != null) {
      void startCheckout({ customerSelectedAmountCents: validAmountCents, priceOptionId: next.priceOptionId });
    }
  }

  const payDisabled = next?.kind === 'voluntary' ? validAmountCents == null || opening : !next || opening;
  const payButton = (
    <Button
      variant="primary"
      size="lg"
      fullWidth
      disabled={payDisabled}
      onClick={startPayment}
      type="button"
    >
      {opening ? 'Opening checkout...' : next?.kind === 'voluntary' ? ctaText : `${copy.ctaLabel ?? 'Checkout'}${shownAmountCents == null ? '' : ` ${formatMoneyCents(shownAmountCents, currency)}${copy.cadence ?? ''}`}`}
    </Button>
  );

  return (
    <article
      aria-labelledby={nameId}
      className="program-pricing-card"
      data-featured={copy.featured ? 'true' : undefined}
      data-offer-card={offerId}
      data-next-step={next?.kind ?? 'none'}
    >
      <div className="program-pricing-name-row">
        <span className="program-pricing-name" id={nameId}>{copy.planName}</span>
        {next?.kind === 'booking' ? null : (
          <span className="program-pricing-price-row">
            <span className="program-pricing-price">
              {next == null ? 'Unavailable' : shownAmountCents == null ? 'Choose amount' : formatMoneyCents(shownAmountCents, currency)}
            </span>
            {next == null || shownAmountCents == null ? null : <span className="program-pricing-cadence">{copy.cadence}</span>}
          </span>
        )}
      </div>
      <p className="program-pricing-model">{copy.modelNote}</p>
      {next == null ? (
        <div className="grid gap-3" role="alert">
          <p className="m-0 text-[15px] leading-[1.5]">Live pricing for this offer is unavailable right now.</p>
          <Button onClick={() => window.location.reload()} size="md" type="button" variant="primary">
            Try again
          </Button>
        </div>
      ) : null}
      {next?.kind === 'voluntary' ? (
        <div className="program-pricing-more">
          <p className="m-0 text-[15px] leading-[1.5]">{copy.minimumLabel ?? 'Starts at'} {formatMoneyCents(policy!.minCents, policy!.currency)}{copy.cadence ?? ''}. You can pay more if you like.</p>
          <Button
            aria-controls={showMoreAmounts ? `program-pricing-more-amounts-${offerId.replace(/[^a-zA-Z0-9]+/g, '-')}${idSuffix}` : undefined}
            aria-expanded={showMoreAmounts}
            className="program-pricing-more-toggle"
            onClick={toggleMoreAmounts}
            size="md"
            type="button"
            variant="ghost"
          >
            {showMoreAmounts ? 'Hide other amounts' : 'Want to contribute more?'}
          </Button>
          {showMoreAmounts ? <fieldset className="program-pricing-choices grid gap-3 text-left text-[15px] leading-[1.5]" id={`program-pricing-more-amounts-${offerId.replace(/[^a-zA-Z0-9]+/g, '-')}${idSuffix}`}>
            <legend className="font-bold text-[15px] leading-[1.5]">Choose your monthly amount</legend>
            <div aria-label="Suggested contribution amounts" className="program-pricing-tier-rail">
              {[policy!.minCents, ...policy!.suggestedCents.filter((amountCents) => amountCents > policy!.minCents)].map((amountCents) => (
                <Button
                  active={!customEditing && selectedCents === amountCents}
                  className="program-pricing-tier"
                  data-highlighted={policy!.highlightedCents === amountCents ? 'true' : undefined}
                  key={amountCents}
                  onClick={() => chooseSuggestedAmount(amountCents)}
                  size="md"
                  type="button"
                  variant="quiet"
                >
                  {!customEditing && selectedCents === amountCents ? '✓ ' : ''}
                  {formatMoneyCents(amountCents, policy!.currency)}
                  {policy!.highlightedCents === amountCents && policy!.highlightLabel ? (
                    <span className="program-pricing-tier-badge">{policy!.highlightLabel}</span>
                  ) : null}
                </Button>
              ))}
            </div>
            {policy!.allowCustom ? <label className="program-pricing-custom">
              <span>Custom amount</span>
              <span className="program-pricing-custom-input-row">
                <span aria-hidden="true" className="program-pricing-currency">{policy!.currency}</span>
                <input
                  aria-describedby={`program-pricing-amount-message-${offerId.replace(/[^a-zA-Z0-9]+/g, '-')}${idSuffix}`}
                  aria-invalid={invalidAmount}
                  autoComplete="off"
                  className="program-pricing-custom-input"
                  inputMode="decimal"
                  min={String(policy!.minCents / 100)}
                  name="programPatronAmount"
                  onChange={(event) => {
                    setCustomEditing(true);
                    setCustomValue(event.currentTarget.value);
                  }}
                  onFocus={(event) => { if (!customEditing) event.currentTarget.select(); }}
                  step="0.01"
                  type="text"
                  value={customEditing ? customValue : formatEditableDecimal(selectedCents ?? policy!.minCents, policy!.currency)}
                />
              </span>
            </label> : null}
            <p
              className="m-0 text-[15px] leading-[1.5]"
              id={`program-pricing-amount-message-${offerId.replace(/[^a-zA-Z0-9]+/g, '-')}${idSuffix}`}
              role={invalidAmount ? 'alert' : 'status'}
            >
              {amountMessage}
            </p>
          </fieldset> : null}
          {payButton}
        </div>
      ) : null}
      {copy.features.length === 0 ? null : (
        <ul className="program-pricing-features" aria-label={`${copy.planName} includes`}>
          {copy.features.map((feature) => (
            <li key={feature.id}>
              <span className="program-pricing-bit" aria-hidden="true">✓</span>
              <div className="min-w-0">
                <Text as="span" variant="body" className="program-pricing-feature-label">
                  {feature.label}
                </Text>
              </div>
              <div className="program-pricing-showcase"><ShowcaseStrip ariaLabel={`${feature.label} showcase`} items={feature.showcase} /></div>
            </li>
          ))}
        </ul>
      )}
      {next?.kind === 'voluntary' ? payButton : null}
      {next?.kind === 'checkout' ? payButton : null}
      {next?.kind === 'booking' && beforeBooking ? <BeforeBookingForm action={beforeBooking} label={copy.ctaLabel ?? 'Book a call'} /> : null}
      {next?.kind === 'booking' && !beforeBooking ? <Button href={next.bookingUrl} size="lg" variant="primary">{copy.ctaLabel ?? 'Book a call'}</Button> : null}
      {checkoutError ? (
        <p className="m-0 rounded-xl border border-red-700/25 bg-red-50 p-3 text-[15px] leading-[1.5] text-red-800" role="alert">
          {checkoutError}
        </p>
      ) : null}
      {copy.footnote ? (
        <Text as="p" variant="body" color="muted" className="program-pricing-footnote" style={{ fontSize: 15, lineHeight: 1.5 }}>
          {copy.footnote}
        </Text>
      ) : null}
    </article>
  );
}
