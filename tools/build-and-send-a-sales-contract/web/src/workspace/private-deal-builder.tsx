// tools/build-and-send-a-sales-contract/web/src/workspace/private-deal-builder.tsx
//
// The private deal builder: pursuit, then customer, product, price lines, message and what they get. The draft lives in
// this screen only; nothing is saved or sent here (the preview is the whole output). Reads are contract-builder-data.ts;
// the price and message rules are do-work/contract-builder-quote.mjs; every visible word is contract-builder-words.json
// or contract-templates.json.

import React from 'react';
import { mountReactSurface } from '../../../../ui';
import { Button, Card, Container, Input, Text, Textarea } from '../../../../ui';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { ScreenState, useScreenLoad } from '../../../../ui/show/screen-state';
import { refusal } from '../../../../workspace-screens/web/src/workspace/failure';
import words from './contract-builder-words.json';
import templates from './contract-templates.json';
import { quoteLines, composeMessage } from '../../../do-work/contract-builder-quote.mjs';
import {
  readPursuits, searchCustomers, readOffers, readPriceParts, readSender, dryRunWithEmailTool,
  type Customer, type Offer, type Pursuit, type PricePart, type Sender,
} from './contract-builder-data';

type Choice = { option: string; quantity?: number; amount_cents?: number };
type Template = { id: string; name: string; subject: string; body: string };

const money = (cents: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
const dollars = (cents: number | null) => (cents === null ? '' : String(Math.round(cents / 100)));
const sortedPieces = (parts: PricePart[]) => [...new Set(parts.map(part => part.piece))];

/** The starting choice of each piece: its first option, one unit, and the owner's amount. */
function startingChoices(parts: PricePart[]): Record<string, Choice> {
  return Object.fromEntries(sortedPieces(parts).map(piece => {
    const first = parts.find(part => part.piece === piece)!;
    return [piece, { option: first.option_key, quantity: 1 }];
  }));
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card variant="surface" padding="sm" layout="stack" className="min-w-0 gap-3">
      <Text variant="heading-xs" color="strong">{title}</Text>
      {children}
    </Card>
  );
}

function PickButtons<T extends { id: string }>({ items, label, selected, onPick }: { items: T[]; label: (item: T) => string; selected?: string; onPick: (item: T) => void }) {
  return (
    <Container layout="horizontal" wrap gap="xs">
      {items.map(item => (
        <Button key={item.id} variant={item.id === selected ? 'secondary' : 'ghost'} size="sm" aria-pressed={item.id === selected} onClick={() => onPick(item)}>
          {label(item)}
        </Button>
      ))}
    </Container>
  );
}

function PrivateDealBuilder({ pursuits }: { pursuits: Pursuit[] }) {
  const [pursuit, setPursuit] = React.useState<Pursuit | null>(null);
  const [sender, setSender] = React.useState<Sender | null>(null);
  const [search, setSearch] = React.useState('');
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [offers, setOffers] = React.useState<Offer[]>([]);
  const [offer, setOffer] = React.useState<Offer | null>(null);
  const [parts, setParts] = React.useState<PricePart[]>([]);
  const [choices, setChoices] = React.useState<Record<string, Choice>>({});
  const [template, setTemplate] = React.useState<Template>(templates.templates[0]);
  const [subject, setSubject] = React.useState(template.subject);
  const [body, setBody] = React.useState(template.body);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState<{ from: string; to: string; subject: string } | null>(null);
  const [checkFailure, setCheckFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!pursuit) return;
    let stale = false;
    setFailure(null);
    Promise.all([readSender(pursuit), readOffers(pursuit), searchCustomers(pursuit, '')])
      .then(([read, offerRows, customerRows]) => {
        if (stale) return;
        setSender(read); setOffers(offerRows); setCustomers(customerRows);
      }, () => { if (!stale) setFailure(words.read_failed); });
    return () => { stale = true; };
  }, [pursuit]);

  React.useEffect(() => {
    if (!pursuit) return;
    const handle = window.setTimeout(() => {
      searchCustomers(pursuit, search).then(setCustomers, () => setFailure(words.read_failed));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [pursuit, search]);

  React.useEffect(() => {
    if (!pursuit || !offer) return;
    let stale = false;
    readPriceParts(pursuit, offer.id).then(rows => {
      if (stale) return;
      setParts(rows); setChoices(startingChoices(rows));
    }, () => { if (!stale) setFailure(words.read_failed); });
    return () => { stale = true; };
  }, [pursuit, offer]);

  const quote = React.useMemo(() => {
    if (!parts.length) return null;
    try { return quoteLines(parts, choices); } catch { return null; }
  }, [parts, choices]);

  const setChoice = (piece: string, change: Partial<Choice>) => setChoices(current => ({ ...current, [piece]: { ...current[piece], ...change } }));
  const pickTemplate = (next: Template) => { setTemplate(next); setSubject(next.subject); setBody(next.body); };

  const message = React.useMemo(() => {
    if (!quote || !sender || !customer || !offer) return null;
    return composeMessage({
      sender, customer, template: { subject, body }, offerLabel: offer.label, lines: quote.lines, total_cents: quote.total_cents,
      link: null, money, words,
    });
  }, [quote, sender, customer, offer, subject, body]);

  return (
    <Container layout="vertical" gap="md" className="min-w-0">
      <Text variant="heading-sm" color="strong">{words.title}</Text>
      {failure ? <Text variant="body-xs" color="muted">{failure}</Text> : null}

      <Step title={words.steps.pursuit}>
        <Text variant="body-xs" color="muted">{words.pursuit_pick}</Text>
        {pursuits.length ? <PickButtons items={pursuits} label={item => item.title} selected={pursuit?.id} onPick={item => { setPursuit(item); setCustomer(null); setOffer(null); }} /> : <Text variant="body-xs" color="muted">{words.pursuits_none}</Text>}
      </Step>

      {pursuit ? (
        <Step title={words.steps.customer}>
          <Input value={search} placeholder={words.customer_search} onChange={event => setSearch(event.target.value)} />
          {customers.length ? (
            <PickButtons items={customers.map(row => ({ ...row, id: row.id }))} label={row => row.name || row.email} selected={customer?.id} onPick={row => setCustomer(row)} />
          ) : <Text variant="body-xs" color="muted">{words.customers_none}</Text>}
        </Step>
      ) : null}

      {pursuit && customer ? (
        <Step title={words.steps.product}>
          <Text variant="body-xs" color="muted">{words.product_pick}</Text>
          {offers.length ? <PickButtons items={offers} label={item => item.label} selected={offer?.id} onPick={item => setOffer(item)} /> : <Text variant="body-xs" color="muted">{words.products_none}</Text>}
        </Step>
      ) : null}

      {offer && parts.length ? (
        <Step title={words.steps.lines}>
          <Text variant="body-xs" color="muted">{words.lines_hint}</Text>
          {sortedPieces(parts).map(piece => {
            const options = parts.filter(part => part.piece === piece);
            const chosen = choices[piece];
            const part = options.find(row => row.option_key === chosen?.option) ?? options[0];
            return (
              <Container key={piece} layout="vertical" gap="xs" className="min-w-0">
                <PickButtons items={options.map(row => ({ ...row, id: row.option_key }))} label={row => row.label} selected={chosen?.option} onPick={row => setChoice(piece, { option: row.option_key })} />
                {part.basis === 'per_unit' ? (
                  <Container layout="vertical" gap="xs">
                    <Text variant="label" color="muted">{words.line_quantity}</Text>
                    <Container layout="horizontal" gap="xs">
                      <Input type="number" value={String(chosen?.quantity ?? 1)} aria-label={words.line_quantity} onChange={event => setChoice(piece, { quantity: Math.trunc(Number(event.target.value)) })} />
                      <Text variant="body-xs" color="muted">{part.unit ? words.line_unit.replace('{unit}', part.unit) : ''}</Text>
                    </Container>
                  </Container>
                ) : null}
                {part.basis === 'flat' || part.basis === 'per_unit' ? (
                  <Container layout="vertical" gap="xs">
                    <Text variant="label" color="muted">{words.line_amount}</Text>
                    <Input type="number" value={dollars(chosen?.amount_cents ?? part.amount_cents)} aria-label={words.line_amount} placeholder={words.unpriced}
                      onChange={event => { const value = Math.round(Number(event.target.value)); if (Number.isFinite(value) && value >= 0) setChoice(piece, { amount_cents: value * 100 }); }} />
                  </Container>
                ) : null}
                {part.basis === 'percent' ? <Text variant="body-xs" color="muted">{`${words.line_percent}: ${part.percent}%`}</Text> : null}
                {part.basis === 'at_cost' ? <Text variant="body-xs" color="muted">{`${part.label} — ${words.line_at_cost}`}</Text> : null}
              </Container>
            );
          })}
          <Text variant="heading-xs" color="strong">{`${words.total}: ${quote?.total_cents === null || quote?.total_cents === undefined ? words.unpriced : money(quote.total_cents)}`}</Text>
        </Step>
      ) : null}

      {offer && quote ? (
        <Step title={words.steps.template}>
          <Text variant="body-xs" color="muted">{words.template_pick}</Text>
          <PickButtons items={templates.templates} label={item => item.name} selected={template.id} onPick={pickTemplate} />
          <Input value={subject} aria-label={words.subject} onChange={event => setSubject(event.target.value)} />
          <Textarea value={body} aria-label={words.body} rows={Math.max(8, body.split('\n').length + Math.ceil(body.length / 70))} onChange={event => setBody(event.target.value)} />
        </Step>
      ) : null}

      {message ? (
        <Step title={words.steps.preview}>
          <Text variant="body-xs" color="muted">{`${words.preview_to}: ${message.to}`}</Text>
          <Text variant="body-xs" color="muted">{`${words.preview_from}: ${message.from}`}</Text>
          {message.reply_to ? <Text variant="body-xs" color="muted">{`${words.preview_reply_to}: ${message.reply_to}`}</Text> : null}
          <Text variant="heading-xs" color="strong">{message.subject}</Text>
          <Text variant="body-sm" color="default" wrap="preserve">{message.body}</Text>
          {message.footer ? <Text variant="body-xs" color="muted">{`${words.preview_footer}: ${message.footer}`}</Text> : null}
          <Button variant="outline" size="sm" className="self-start" onClick={() => {
            setChecked(null); setCheckFailure(null);
            dryRunWithEmailTool(sender!, message).then(
              answer => setChecked(answer),
              () => setCheckFailure(words.check_failed),
            );
          }}>{words.check_send}</Button>
          {checked ? <Text variant="body-xs" color="muted">{`${words.checked} ${checked.from} → ${checked.to}`}</Text> : null}
          {checkFailure ? <Text variant="body-xs" color="muted">{checkFailure}</Text> : null}
          <Text variant="body-xs" color="muted">{words.preview_note}</Text>
        </Step>
      ) : null}
      {offer && !sender && !failure ? <Text variant="body-xs" color="muted">{words.sender_missing}</Text> : null}
    </Container>
  );
}

function PrivateDealScreen() {
  const loaded = useScreenLoad('private-deal-builder', { loading: { label: words.reading, layout: 'editor' }, read: readPursuits, failed: refusal(words.read_failed) });
  return (
    <ErrorBoundary zoneName="private deal builder">
      {loaded.state ? <ScreenState state={loaded.state} /> : <PrivateDealBuilder pursuits={loaded.value} />}
    </ErrorBoundary>
  );
}

export function mountPrivateDealBuilder(element: HTMLElement): () => void {
  return mountReactSurface(element, <PrivateDealScreen />);
}
