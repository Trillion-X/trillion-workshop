'use client';

// The patron contribution card uses the checkout chooser's interaction pattern
// inside the existing FounderPricingSection visual language. The live offer
// policy is primary, with an honest unavailable state during boot.

import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { Text, Button, Container, ShowcaseStrip } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { LANDING_PRICING_SECTION_ID } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import { useProgramLandingData } from './ProgramLandingData';
import {
  parsePatronAmount,
  readPatronPolicy,
  readSystemOffer,
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

async function startCheckoutThroughThisHost(request: DirectCheckoutRequest): Promise<DirectCheckoutResult> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'checkout.start-checkout',
    payload: request,
  });
  const text = new TextDecoder().decode(reply.payload);
  let result: DirectCheckoutResult & { error?: string } = {};
  try {
    result = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error('Checkout could not start. Please try again.');
  }
  if (result.error) {
    throw new Error(result.error || 'Checkout could not start. Please try again.');
  }
  return result;
}

declare global {
  interface Window {
    __programStartCheckout__?: (request: DirectCheckoutRequest) => Promise<DirectCheckoutResult>;
    // Told once per page when a price has been on screen, with the offers shown.
    // A host that counts who reached a price supplies it; otherwise it is absent.
    __programReachedPrice__?: (offerIds: string[]) => void;
  }
}

type PatronPolicyEnvelope =
  | { status: 'ready'; offerId: string; policy: unknown; priceOptionId: string }
  | { status: 'unavailable'; reason?: string };

type SystemOfferEnvelope =
  | {
      status: 'ready';
      offerId: string;
      priceOptionId: string;
      amountCents: number;
      currency: string;
      postPurchaseRoutePath: string;
    }
  | { status: 'unavailable'; reason?: string };

declare global {
  interface Window {
    __programPatronPolicyForThisPage__?: PatronPolicyEnvelope;
    __programSystemOfferForThisPage__?: SystemOfferEnvelope;
  }
}

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
// would otherwise put the same element id in the document twice, which breaks
// every `aria-labelledby` pointing at it and silently gives a screen reader
// the wrong plan name. The anchor is the same reason: the nav and every call
// to action point at the canonical `#pricing`, so only the instance that
// claims that name carries it, and the second is addressed by its own id.
export function ProgramPricingSection({ flatSurfaces, instanceId, embedded = false }: { flatSurfaces?: boolean; instanceId?: string; embedded?: boolean }) {
  const plan = useProgramLandingData().pricing;
  const anchorId = instanceId ?? LANDING_PRICING_SECTION_ID;
  const scoped = (name: string) => (instanceId ? `${name}-${instanceId}` : name);
  const policy = typeof window === 'undefined'
    ? null
    : readPatronPolicy(window.__programPatronPolicyForThisPage__, plan.patron.offerId);
  const systemOffer = typeof window === 'undefined'
    ? null
    : readSystemOffer(window.__programSystemOfferForThisPage__, plan.system.offerId);
  const [customEditing, setCustomEditing] = React.useState(false);
  const [showMoreAmounts, setShowMoreAmounts] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const [selectedCents, setSelectedCents] = React.useState<number | null>(
    policy?.minCents ?? null,
  );
  const [openingCard, setOpeningCard] = React.useState<null | 'system' | 'patron'>(null);
  const [checkoutError, setCheckoutError] = React.useState<null | { card: 'system' | 'patron'; message: string }>(null);

  // Someone who had the price on screen and did not buy is what moves a
  // discovered price down, so the host is told once, when at least 40% of the
  // section has been visible.
  React.useEffect(() => {
    const report = window.__programReachedPrice__;
    const section = document.getElementById(anchorId);
    if (!report || !section || typeof IntersectionObserver === 'undefined') return;
    const shownOfferIds = [plan.patron, plan.system].filter((card) => card.shown !== false).map((card) => card.offerId);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      report(shownOfferIds);
    }, { threshold: 0.4 });
    observer.observe(section);
    return () => observer.disconnect();
  }, [anchorId, plan.patron, plan.system]);

  // The direct no-friction pay path: pay click -> start-checkout -> the provider's
  // own hosted page. NO interstitial form ever sits between intent and Stripe
  // (Stripe collects the buyer's email/name; consent is asserted by the labeled
  // pay click itself). Failure renders inline on the card; the button returns.
  async function startDirectCheckout(card: 'system' | 'patron', selection: { offerId: string; priceOptionId: string; customerSelectedAmountCents?: number }) {
    const sender = window.__programStartCheckout__ ?? startCheckoutThroughThisHost;
    if (openingCard) return;
    setCheckoutError(null);
    setOpeningCard(card);
    try {
      const result = await sender({
        checkoutAttemptId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `program-${Date.now()}`,
        checkoutStartedAt: new Date().toISOString(),
        consent: { billing: true, legal: true },
        ...(selection.customerSelectedAmountCents == null ? {} : { customerSelectedAmountCents: selection.customerSelectedAmountCents }),
        offerId: selection.offerId,
        priceOptionId: selection.priceOptionId,
        returnUrlBase: window.location.origin,
      });
      if (!result.redirectUrl || !/^https:\/\/checkout\.stripe\.com\//.test(result.redirectUrl)) {
        throw new Error('Checkout did not return a valid payment destination. Please try again.');
      }
      window.location.assign(result.redirectUrl);
    } catch (caught) {
      setCheckoutError({
        card,
        message: caught instanceof Error ? caught.message : 'Checkout could not start. Please try again.',
      });
      setOpeningCard(null);
    }
  }

  const customState = !policy
    ? { kind: 'editing' } satisfies PatronAmountState
    : customEditing
      ? parsePatronAmount(customValue, policy.minCents, policy.maxCents)
      : selectedCents == null
        ? { kind: 'editing' } satisfies PatronAmountState
        : { kind: 'valid', amountCents: selectedCents } satisfies PatronAmountState;
  const validAmountCents = customState.kind === 'valid' ? customState.amountCents : null;
  const invalidAmount = customState.kind === 'invalid'
    || customState.kind === 'below-min'
    || customState.kind === 'above-max';
  const amountMessage = customState.kind === 'editing'
    ? 'Enter an amount to continue.'
    : customState.kind === 'invalid'
      ? `Membership starts at ${formatMoneyCents(policy?.minCents ?? 0, policy?.currency ?? 'usd')} per month.`
      : customState.kind === 'below-min'
        ? `Membership starts at ${formatMoneyCents(policy?.minCents ?? 0, policy?.currency ?? 'usd')} per month.`
        : customState.kind === 'above-max' && policy?.maxCents != null
          ? `The maximum contribution is ${formatMoneyCents(policy.maxCents, policy.currency)}.`
          : `You selected ${formatMoneyCents(customState.amountCents, policy?.currency ?? 'usd')}.`;
  const ctaText = validAmountCents == null
    ? 'Enter an amount'
    : `Checkout · ${formatMoneyCents(validAmountCents, policy?.currency ?? 'usd')}${plan.patron.cadence}`;

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

  function startPatronCheckout() {
    if (validAmountCents == null) return;
    if (!policy) return;
    void startDirectCheckout('patron', {
      customerSelectedAmountCents: validAmountCents,
      offerId: policy.offerId,
      priceOptionId: policy.priceOptionId,
    });
  }

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
        .program-pricing-footnote { text-align: center; letter-spacing: -0.01em; }
        .program-pricing-choices { border: 0; margin: 0; min-width: 0; padding: 0; }
        .program-pricing-choices legend { padding: 0 0 4px; }
        .program-pricing-custom { display: grid; gap: 8px; font-size: 15px; font-weight: 700; line-height: 1.5; margin-top: 12px; min-width: 0; }
        .program-pricing-custom-input-row { align-items: stretch; display: grid; grid-template-columns: auto minmax(0, 1fr); min-width: 0; }
        .program-pricing-currency { align-items: center; border: 1px solid rgba(15,23,42,0.25); border-right: 0; display: flex; font-size: 13px; padding: 0 10px; text-transform: uppercase; }
        .program-pricing-custom-input { background: rgba(255,255,255,0.5); border: 1px solid rgba(15,23,42,0.25); box-sizing: border-box; font: inherit; min-height: 44px; min-width: 0; padding: 8px 10px; width: 100%; }
        .program-pricing-more { display: grid; gap: 12px; }
        .program-pricing-more-toggle { box-shadow: 0 2px 8px rgba(15,23,42,0.05); color: #0f172a; font-size: 15px; font-weight: 700; justify-self: center; text-decoration: none; }
      `}</style>
      {!embedded ? <TextColumn measure="hero" align="center" className="gap-3 mb-10 md:mb-12">
        <Text
          as="h2"
          className="program-heading"
          style={{ ...PROGRAM_HERO_ENGRAVED_HEADING_STYLE, textAlign: 'center' }}
          variant="heading-2xl"
          data-testid="program-pricing-conviction"
        >
          {plan.heading}
        </Text>
      </TextColumn> : null}
      {/* Which offer comes first, and which one is featured, is DATA
          (`order`, `featured` on each plan). The first card is the one a
          reader assumes is "the" price, so it is a business decision, not a
          layout detail: buyers who came for the lessons were paying for the
          software pre-order because it sat first and featured. `shown: false`
          keeps an offer sellable elsewhere while this page does not offer it;
          a lone card sits centred rather than in half of a two-column grid. */}
      <Container
        layout="grid"
        gap="xl"
        width="full"
        maxWidth="5xl"
        className="mx-auto program-pricing-grid"
        alignItems="stretch"
      >
        {plan.system.shown === false ? null : (
        <article
          aria-labelledby={scoped("program-system-plan-name")}
          className="program-pricing-card"
          data-featured={plan.system.featured ? 'true' : undefined}
          data-offer-card="system"
          data-post-purchase-path={systemOffer?.postPurchaseRoutePath}
          style={{ order: plan.system.order ?? 0 }}
        >
          <div className="program-pricing-name-row">
            <span className="program-pricing-name" id={scoped("program-system-plan-name")}>{plan.system.planName}</span>
            <span className="program-pricing-price-row"><span className="program-pricing-price">{systemOffer ? formatMoneyCents(systemOffer.amountCents, systemOffer.currency) : 'Unavailable'}</span>{systemOffer ? <span className="program-pricing-cadence">{plan.system.cadence}</span> : null}</span>
          </div>
          <p className="program-pricing-model">{plan.system.modelNote}</p>
          {!systemOffer ? (
            <div className="grid gap-3" role="alert">
              <p className="m-0 text-[15px] leading-[1.5]">Live System pricing is unavailable right now.</p>
              <Button flat={flatSurfaces} onClick={() => window.location.reload()} size="md" type="button" variant="hardware">
                Try again
              </Button>
            </div>
          ) : null}
          <ul className="program-pricing-features" aria-label={`${plan.system.planName} includes`} data-testid="program-pricing-bullets">
            {plan.system.features.map((feature) => (
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
          <Button
            variant="hardware"
            size="lg"
            flat={flatSurfaces}
            fullWidth
            disabled={!systemOffer || openingCard !== null}
            onClick={() => {
              if (!systemOffer) return;
              void startDirectCheckout('system', {
                offerId: systemOffer.offerId,
                priceOptionId: systemOffer.priceOptionId,
              });
            }}
            type="button"
          >
            {openingCard === 'system' ? 'Opening checkout...' : systemOffer ? `${plan.system.ctaLabel} ${formatMoneyCents(systemOffer.amountCents, systemOffer.currency)} ${plan.system.cadence}` : 'Live price unavailable'}
          </Button>
          {checkoutError?.card === 'system' ? (
            <p className="m-0 rounded-xl border border-red-700/25 bg-red-50 p-3 text-[15px] leading-[1.5] text-red-800" role="alert">
              {checkoutError.message}
            </p>
          ) : null}
          <Text as="p" variant="body" color="muted" className="program-pricing-footnote" style={{ fontSize: 15, lineHeight: 1.5 }}>
            {plan.system.footnote}
          </Text>
        </article>
        )}

        {plan.patron.shown === false ? null : (
        <article
          aria-labelledby={scoped("program-patron-plan-name")}
          className="program-pricing-card"
          data-featured={plan.patron.featured ? 'true' : undefined}
          data-offer-card="patron"
          style={{ order: plan.patron.order ?? 0 }}
        >
          <div className="program-pricing-name-row">
            <span className="program-pricing-name" id={scoped("program-patron-plan-name")}>{plan.patron.planName}</span>
            <span className="program-pricing-price-row"><span className="program-pricing-price">{validAmountCents == null ? 'Choose amount' : formatMoneyCents(validAmountCents, policy?.currency ?? 'usd')}</span>{validAmountCents == null ? null : <span className="program-pricing-cadence">{plan.patron.cadence}</span>}</span>
          </div>
          <p className="program-pricing-model">{plan.patron.modelNote}</p>
          {!policy ? (
            <div className="grid gap-3" role="alert">
              <p className="m-0 text-[15px] leading-[1.5]">Live contribution options are unavailable right now.</p>
              <Button flat={flatSurfaces} onClick={() => window.location.reload()} size="md" type="button" variant="hardware">
                Try again
              </Button>
            </div>
          ) : <div className="program-pricing-more">
            <p className="m-0 text-[15px] leading-[1.5]">Membership starts at {formatMoneyCents(policy.minCents, policy.currency)} {plan.patron.cadence}. You can pay more if you like.</p>
            <Button
              aria-controls={showMoreAmounts ? scoped('program-pricing-more-amounts') : undefined}
              aria-expanded={showMoreAmounts}
              className="program-pricing-more-toggle"
              flat={flatSurfaces}
              onClick={toggleMoreAmounts}
              size="md"
              type="button"
              variant="ghost"
            >
              {showMoreAmounts ? 'Hide other amounts' : 'Want to contribute more?'}
            </Button>
            {showMoreAmounts ? <fieldset className="program-pricing-choices grid gap-3 text-left text-[15px] leading-[1.5]" id={scoped('program-pricing-more-amounts')}>
            <legend className="font-bold text-[15px] leading-[1.5]">Choose your monthly amount</legend>
            <div aria-label="Suggested contribution amounts" className="program-pricing-tier-rail">
              {[policy.minCents, ...policy.suggestedCents.filter((amountCents) => amountCents > policy.minCents)].map((amountCents) => (
                <Button
                  aria-pressed={!customEditing && selectedCents === amountCents}
                  className="program-pricing-tier"
                  data-highlighted={policy.highlightedCents === amountCents ? 'true' : undefined}
                  flat={flatSurfaces}
                  key={amountCents}
                  onClick={() => chooseSuggestedAmount(amountCents)}
                  size="md"
                  type="button"
                  variant="hardware"
                >
                  {!customEditing && selectedCents === amountCents ? '✓ ' : ''}
                  {formatMoneyCents(amountCents, policy.currency)}
                  {policy.highlightedCents === amountCents && policy.highlightLabel ? (
                    <span className="program-pricing-tier-badge">{policy.highlightLabel}</span>
                  ) : null}
                </Button>
              ))}
            </div>
            {policy.allowCustom ? <label className="program-pricing-custom">
              <span>Custom amount</span>
              <span className="program-pricing-custom-input-row">
                <span aria-hidden="true" className="program-pricing-currency">{policy.currency}</span>
                <input
                  aria-describedby={scoped("program-pricing-amount-message")}
                  aria-invalid={invalidAmount}
                  autoComplete="off"
                  className="program-pricing-custom-input"
                  inputMode="decimal"
                  min={policy ? String(policy.minCents / 100) : undefined}
                  name="programPatronAmount"
                  onChange={(event) => {
                    setCustomEditing(true);
                    setCustomValue(event.currentTarget.value);
                  }}
                  onFocus={(event) => { if (!customEditing) event.currentTarget.select(); }}
                  step="0.01"
                  type="text"
                  value={customEditing ? customValue : formatEditableDecimal(selectedCents ?? policy.minCents, policy.currency)}
                />
              </span>
            </label> : null}
            <p
              className="m-0 text-[15px] leading-[1.5]"
              id={scoped("program-pricing-amount-message")}
              role={invalidAmount ? 'alert' : 'status'}
            >
              {amountMessage}
            </p>
          </fieldset> : null}
            <Button
              variant="hardware"
              size="lg"
              flat={flatSurfaces}
              fullWidth
              disabled={validAmountCents == null || openingCard !== null}
              onClick={startPatronCheckout}
              type="button"
            >
              {openingCard === 'patron' ? 'Opening checkout...' : ctaText}
            </Button>
            {checkoutError?.card === 'patron' ? (
              <p className="m-0 rounded-xl border border-red-700/25 bg-red-50 p-3 text-[15px] leading-[1.5] text-red-800" role="alert">{checkoutError.message}</p>
            ) : null}
          </div>}
          <ul className="program-pricing-features" aria-label={`${plan.patron.planName} includes`}>
            {plan.patron.features.map((feature) => (
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
          <Button
            variant="hardware"
            size="lg"
            flat={flatSurfaces}
            fullWidth
            disabled={validAmountCents == null || openingCard !== null}
            onClick={startPatronCheckout}
            type="button"
          >
            {openingCard === 'patron' ? 'Opening checkout...' : ctaText}
          </Button>
        </article>
        )}
      </Container>
    </SectionShell>
  );
}
