// tools/ui/show/pricing/PricingCard.tsx
//
// PURPOSE
//   One price card as a landing page shows it: the plan's name and price, a line about how the price works, an optional slot
//   for the amount the buyer picks, the groups of what is included (each a tick, a line and a strip of pictures), and one
//   Checkout button. A page row names it as `ui/show/pricing/PricingCard.tsx#PricingCard`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no checkout call while it renders. The press is the host's: `onCheckout` is called when
//      the button is pressed, or the button is a link when `cta.href` is given. A page that owns the amount the buyer picks
//      passes it as `price` and its picker as `amounts`.
//   2. Nothing about payment is decided here: the words of the button, the price and its cadence are the offer's own, passed in.
//   3. A feature's pictures are the shared ShowcaseStrip's; a feature with none draws its line alone.
//   4. Built from shared parts (Text, Container, Button, ShowcaseStrip); no raw HTML, no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../button/Button.tsx';
import { Container } from '../container/index.ts';
import { ShowcaseStrip, Text } from '../marketing-page/MarketingPagePrimitives.tsx';

export type PricingFeature = {
  id: string;
  label: string;
  /** Pictures under the line: each {id, src, kind?, label?, detail?}. */
  showcase?: readonly { id: string; src?: string; kind?: 'image' | 'video'; label?: string; detail?: string }[];
};

export type PricingCardProps = {
  id: string;
  name: string;
  /** The price as written, such as "$99"; none draws no price (a card that books a call). */
  price?: string;
  /** What the price is per, such as "/month". */
  cadence?: string;
  /** A line about how the price works. */
  note?: string;
  /** A slot the host draws between the note and the features (the amount picker). */
  amounts?: React.ReactNode;
  features?: readonly PricingFeature[];
  cta: { label: string; href?: string };
  onCheckout?: () => void;
  /** True while the checkout is opening. */
  pending?: boolean;
  /** Why a press did nothing. */
  error?: string;
  footnote?: string;
  /** Draw the Checkout button again under the features, as a long card does. */
  repeatCta?: boolean;
};

function Cta({ cta, onCheckout, pending }: Pick<PricingCardProps, 'cta' | 'onCheckout' | 'pending'>) {
  return (
    <Button variant="primary" size="lg" fullWidth href={cta.href} disabled={pending} onClick={cta.href ? undefined : onCheckout} data-pricing-cta>
      {cta.label}
    </Button>
  );
}

export function View(props: PricingCardProps) {
  const { id, name, price, cadence, note, amounts, features = [], cta, onCheckout, pending, error, footnote, repeatCta = features.length > 2 } = props;
  return (
    <Text as="article" className="grid gap-4" data-offer-card={id}>
      <Container layout="horizontal" justifyContent="between" alignItems="baseline" width="full">
        <Text as="h3" variant="heading-lg" color="strong">{name}</Text>
        {price ? (
          <Text as="p" variant="heading-xl" color="strong">
            {price}
            {cadence ? <Text as="span" variant="label" color="muted">{cadence}</Text> : null}
          </Text>
        ) : null}
      </Container>
      {note ? <Text as="p" color="muted">{note}</Text> : null}
      {amounts ?? null}
      <Cta cta={cta} onCheckout={onCheckout} pending={pending} />
      {error ? <Text as="p" role="alert" color="error">{error}</Text> : null}
      {features.length === 0 ? null : (
        <Text as="ul" className="m-0 grid list-none gap-4 p-0" aria-label={`${name} includes`}>
          {features.map(feature => (
            <Text as="li" key={feature.id} className="grid gap-2" data-feature={feature.id}>
              <Text as="p" weight="medium">{`✓ ${feature.label}`}</Text>
              {feature.showcase?.length ? <ShowcaseStrip ariaLabel={`${feature.label} showcase`} items={feature.showcase} /> : null}
            </Text>
          ))}
        </Text>
      )}
      {repeatCta ? <Cta cta={cta} onCheckout={onCheckout} pending={pending} /> : null}
      {footnote ? <Text as="p" variant="caption" color="muted">{footnote}</Text> : null}
    </Text>
  );
}

export { View as PricingCard };
