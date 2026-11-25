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
//      A page row that has no callbacks gives `action` instead: the card is then one plain form (method post) and the
//      Checkout button submits it with `hiddenFields` (name -> value, such as which plan) and whatever fields `amounts`
//      draws. The page that receives the post is the host's.
//      A plan whose buyer may pay more than its price gives `more` (plain words and amounts, below): the card says what the
//      price starts at, and a button opens the amounts to pick from; the one picked replaces the price shown, the `{price}` in
//      the button's words and the form's `field` (the amount the post carries), and the post carries nothing else new.
//   3. A feature's pictures are the shared ShowcaseStrip's; a feature with none draws its line alone.
//   4. Built from shared parts (Text, Container, Button, ShowcaseStrip); no raw HTML, no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../button/Button.tsx';
import { Input } from '../coss/ui/input.tsx';
import { Container } from '../container/index.ts';
import { Form } from '../form/Form.tsx';
import { ShowcaseStrip, Text } from '../marketing-page/MarketingPagePrimitives.tsx';
import { CARD_CADENCE, CARD_FEATURE, CARD_NAME, CARD_NOTE, CARD_PRICE, centsOf } from './card-type.ts';

export type PricingFeature = {
  id: string;
  label: string;
  /** Pictures under the line: each {id, src, kind?, label?, detail?}. */
  showcase?: readonly { id: string; src?: string; kind?: 'image' | 'video'; label?: string; detail?: string }[];
};

/** What a buyer who may pay more sees: a line, a button that opens the amounts, and the amounts (cents) to pick from. */
export type PricingMore = {
  /** The line above the button, e.g. what the price starts at. */
  line?: string;
  toggle: string;
  hide?: string;
  legend?: string;
  /** The form field the amount in cents is posted in (it replaces the same name in `hiddenFields`). */
  field: string;
  options: readonly { cents: number; label: string }[];
  /** One more choice: an amount the buyer types, at least `min_cents`. Its words are the row's: the label of the box and what
   *  is said of an amount under the least (`too_low`, `{min}` is filled in). `currency` (ISO code) draws the amount; USD when left out. */
  custom?: { label: string; min_cents: number; too_low?: string; currency?: string };
};

const moneyOf = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);

export type PricingCardProps = {
  /** The amounts a buyer may pay instead of the price shown (see invariant 1). */
  more?: PricingMore;
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
  /** Where the card posts when the button is pressed; the card is then a plain form and needs no callback. */
  action?: string;
  /** Values the post carries besides those typed into `amounts`: name -> value. */
  hiddenFields?: Readonly<Record<string, string>>;
  /** True while the checkout is opening. */
  pending?: boolean;
  /** Why a press did nothing. */
  error?: string;
  footnote?: string;
  /** Draw the Checkout button again under the features, as a long card does. */
  repeatCta?: boolean;
};

function Cta({ cta, onCheckout, pending, posts }: Pick<PricingCardProps, 'cta' | 'onCheckout' | 'pending'> & { posts: boolean }) {
  return (
    <Button variant="primary" size="lg" fullWidth href={cta.href} disabled={pending} type={posts && !cta.href ? 'submit' : undefined} onClick={cta.href || posts ? undefined : onCheckout} data-pricing-cta>
      {cta.label}
    </Button>
  );
}

export function View(props: PricingCardProps) {
  const { id, name, price: given, cadence, note, amounts, features = [], cta: ctaGiven, onCheckout, action, hiddenFields: fields, pending, error, footnote, more, repeatCta = features.length > 2 } = props;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ cents: number; label: string } | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const typedCents = typed === null ? null : centsOf(typed);
  const tooLow = typed !== null && typed.trim() !== '' && more?.custom !== undefined && (typedCents === null || typedCents < more.custom.min_cents);
  const posts = action !== undefined;
  const price = picked?.label ?? given;
  const cta = { ...ctaGiven, label: ctaGiven.label.replace('{price}', picked?.label ?? given ?? '') };
  const blocked = typed !== null && picked === null;
  const hiddenFields = more && picked ? { ...fields, [more.field]: String(picked.cents) } : fields;
  const body = (
    <>
      <Container layout="vertical" gap="sm" width="full">
        <Text as="h3" style={CARD_NAME}>{name}</Text>
        {price ? (
          <Text as="p" style={CARD_PRICE}>
            {price}
            {cadence ? <Text as="span" style={CARD_CADENCE}>{cadence}</Text> : null}
          </Text>
        ) : null}
      </Container>
      {note ? <Text as="p" style={CARD_NOTE}>{note}</Text> : null}
      {amounts ?? null}
      {more ? (
        <Container layout="vertical" gap="sm" width="full" data-pricing-more>
          {more.line ? <Text as="p" color="muted">{more.line}</Text> : null}
          <Button type="button" variant="quiet" size="md" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? more.hide ?? more.toggle : more.toggle}</Button>
          {open ? (
            <Container layout="vertical" gap="sm" width="full" role="group" aria-label={more.legend}>
              {more.legend ? <Text as="p" weight="medium" color="strong">{more.legend}</Text> : null}
              <Container layout="horizontal" gap="sm" className="flex-wrap">
                {more.options.map(option => (
                  <Button key={option.cents} type="button" variant="outline" size="md" aria-pressed={picked?.cents === option.cents} onClick={() => { setTyped(null); setPicked(option); }}>
                    {`${typed === null && picked?.cents === option.cents ? '✓ ' : ''}${option.label}`}
                  </Button>
                ))}
              </Container>
              {more.custom ? (
                <Container layout="vertical" gap="xs" width="full">
                  <Text as="label" weight="medium" color="strong">{more.custom.label}</Text>
                  <Input type="text" inputMode="decimal" autoComplete="off" size="lg" aria-label={more.custom.label} aria-invalid={tooLow} value={typed ?? ''} placeholder={moneyOf(more.custom.min_cents, more.custom.currency)}
                    onChange={event => {
                      const text = event.target.value;
                      setTyped(text);
                      const cents = centsOf(text);
                      setPicked(cents !== null && cents >= (more.custom?.min_cents ?? 0) ? { cents, label: moneyOf(cents, more.custom?.currency) } : null);
                    }} />
                  {tooLow ? <Text as="p" role="alert" color="error">{(more.custom.too_low ?? '').replace('{min}', moneyOf(more.custom.min_cents, more.custom.currency))}</Text> : null}
                </Container>
              ) : null}
            </Container>
          ) : null}
        </Container>
      ) : null}
      <Cta cta={cta} onCheckout={onCheckout} pending={pending || blocked} posts={posts} />
      {error ? <Text as="p" role="alert" color="error">{error}</Text> : null}
      {features.length === 0 ? null : (
        <Text as="ul" className="m-0 grid list-none gap-4 p-0" aria-label={`${name} includes`}>
          {features.map(feature => (
            <Text as="li" key={feature.id} className="grid gap-2" data-feature={feature.id}>
              <Text as="p" style={CARD_FEATURE} className="flex items-start gap-3"><Text as="span" aria-hidden="true" className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-[#0f172a] text-white"><Check size={14} strokeWidth={3} /></Text>{feature.label}</Text>
              {feature.showcase?.length ? <ShowcaseStrip ariaLabel={`${feature.label} showcase`} items={feature.showcase} /> : null}
            </Text>
          ))}
        </Text>
      )}
      {repeatCta ? <Cta cta={cta} onCheckout={onCheckout} pending={pending || blocked} posts={posts} /> : null}
      {footnote ? <Text as="p" variant="caption" color="muted">{footnote}</Text> : null}
    </>
  );
  return (
    <Text as="article" className="grid gap-4" data-offer-card={id}>
      {posts ? <Form method="post" action={action} hiddenFields={hiddenFields} className="grid gap-4">{body}</Form> : body}
    </Text>
  );
}

export { View as PricingCard };
