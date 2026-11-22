// tools/build-and-send-a-sales-contract/web/src/workspace/private-deal-page.tsx
//
// The page a customer opens from the private link of a deal: the offer, its price lines and total, the date and any expiry,
// and the sign and pay steps. Read-only: opening it changes nothing. Sign and Pay are disabled until a signing tool and a
// payment link are set up; the reason for each sits beside it. Every visible word is private-deal-page-words.json. The look
// is the shared one (tools/ui parts, Screen Look classes); no colour is named here. Storage-free: the caller hands in the
// deal it shows and reads the sign state through read-data/sign-through-deal-link.mjs.

import React from 'react';
import { mountReactSurface } from '../../../../ui';
import { Badge, Button, Card, Container, ImageBlock, Text } from '../../../../ui';
import words from './private-deal-page-words.json';
import { lookFor, PAGE_LOOK } from '../../../../workspace-screens/web/src/page-look.mjs';
import { lookDocumentCss } from '../../../../screen-look/read-data/look-document-css.js';
import { signSection } from '../../../read-data/sign-through-deal-link.mjs';

export type DealLine = {
  label: string; kind: 'amount' | 'percent' | 'at_cost'; basis: string; quantity: number;
  total_cents: number | null; percent: number | null; amount_cents: number | null;
};
export type PrivateDeal = {
  theme_id: string | null; brand_name: string | null; brand_image: string | null; brand_width: number | null; brand_height: number | null;
  offer: string; buyer: string; seller: string; date: string; expires: string | null;
  lines: DealLine[]; total_cents: number | null; signatures: string[]; signedByYou: boolean; proven: boolean;
};

const money = (cents: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);

/** The amount a line adds (or takes away) as the reader sees it: included, a share with its money, at cost, or a price. */
function lineAmount(line: DealLine): string {
  if (line.kind === 'at_cost') return words.at_cost;
  if (line.kind === 'percent') {
    const share = `${line.percent}%`;
    return line.amount_cents === null ? share : `${share} · ${money(line.amount_cents)}`;
  }
  if (line.total_cents === 0) return words.included;
  return line.total_cents === null ? words.unpriced : money(line.total_cents);
}

export function PrivateDealPage({ deal }: { deal: PrivateDeal }) {
  const sign = signSection({ signedByYou: deal.signedByYou, signatures: deal.signatures, proven: deal.proven });
  const [brandShown, setBrandShown] = React.useState(Boolean(deal.brand_image));
  // The pursuit's look: its theme from its own look row, resolved by the shared page look and written as the document's
  // variables (the same look.css the workspace writes). A pursuit with no theme, or one the look does not offer, wears the
  // shared start look. The paper ground fills the whole page: the theme and the canvas class go on the document body.
  React.useEffect(() => {
    const body = document.body;
    const look = deal.theme_id ? lookFor(deal.theme_id) : PAGE_LOOK;
    const style = document.createElement('style');
    style.id = 'private-deal-look';
    style.textContent = lookDocumentCss(look.palette);
    document.head.appendChild(style);
    if (deal.theme_id) body.dataset.theme = deal.theme_id;
    body.classList.add('landing-page');
    return () => { style.remove(); delete body.dataset.theme; body.classList.remove('landing-page'); };
  }, [deal.theme_id]);
  return (
    <Container layout="vertical" gap="md" className="mx-auto min-h-screen w-full min-w-0 max-w-2xl p-4">
      <Container layout="horizontal" className="items-center gap-3">
        {deal.brand_image && brandShown ? <ImageBlock src={deal.brand_image} alt={deal.brand_name ?? ''} rounded="lg" objectFit="cover" style={{ width: deal.brand_width ?? 40, height: deal.brand_height ?? 40 }} className="border border-[var(--border-primary)]" onError={() => setBrandShown(false)} /> : null}
        {deal.brand_name ? <Text variant="heading-sm" color="strong">{deal.brand_name}</Text> : null}
      </Container>
      <Container layout="vertical" gap="xs" className="min-w-0">
        <Text variant="heading-lg" color="strong">{words.title}</Text>
        <Text variant="body-sm" color="muted">{`${words.from}: ${deal.seller}`}</Text>
        <Text variant="body-sm" color="muted">{`${words.for}: ${deal.buyer}`}</Text>
        <Text variant="body-sm" color="muted">{`${words.date}: ${deal.date}`}</Text>
        {deal.expires ? <Text variant="body-sm" color="muted">{`${words.expires}: ${deal.expires}`}</Text> : null}
      </Container>

      <Card variant="surface" padding="md" layout="stack" className="min-w-0 gap-4">
        <Container layout="horizontal" className="items-center justify-between gap-3">
          <Text variant="heading-sm" color="strong">{deal.offer}</Text>
          <Badge variant="muted">{words.offer_badge}</Badge>
        </Container>
        <Text variant="label" color="muted">{words.lines}</Text>
        {deal.lines.map((line, index) => (
          <Container key={index} layout="horizontal" className="justify-between gap-3">
            <Text variant="body-sm" color="default">{line.quantity > 1 && line.basis === 'per_unit' ? `${line.label} × ${line.quantity}` : line.label}</Text>
            <Text variant="body-sm" color="default">{lineAmount(line)}</Text>
          </Container>
        ))}
        <Container layout="horizontal" className="items-baseline justify-between gap-3 border-t pt-3">
          <Text variant="heading-lg" color="strong">{words.total}</Text>
          <Text variant="heading-lg" color="strong">{deal.total_cents === null ? words.unpriced : money(deal.total_cents)}</Text>
        </Container>
      </Card>

      <Card variant="surface" padding="md" layout="stack" className="min-w-0 gap-3">
        <Text variant="heading-xs" color="strong">{words.sign_heading}</Text>
        {sign.kind === 'signed' && sign.signatures.length ? sign.signatures.map((name, index) => <Text key={index} variant="body-sm" color="default">{name}</Text>) : <Text variant="body-sm" color="muted">{words.signatures_none}</Text>}
        <Container layout="horizontal" wrap gap="sm" className="items-center">
          <Button variant="outline" disabled>{words.sign_button}</Button>
          <Text variant="body-xs" color="muted">{words.sign_not_set_up}</Text>
        </Container>
      </Card>

      <Card variant="surface" padding="md" layout="stack" className="min-w-0 gap-3">
        <Text variant="heading-xs" color="strong">{words.pay_heading}</Text>
        <Container layout="horizontal" wrap gap="sm" className="items-center">
          <Button variant="outline" disabled>{words.pay_button}</Button>
          <Text variant="body-xs" color="muted">{words.payment_not_set_up}</Text>
        </Container>
      </Card>

      <Text variant="body-xs" color="muted">{words.read_only}</Text>
    </Container>
  );
}

export function mountPrivateDealPage(element: HTMLElement, deal: PrivateDeal): () => void {
  return mountReactSurface(element, <PrivateDealPage deal={deal} />);
}
