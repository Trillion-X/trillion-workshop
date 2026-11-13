// src/workspace/send-to-an-audience.tsx
//
// PURPOSE
//   The Send step's "A list" side: pick a list (or one of its views), how it reaches them (any channel row of
//   src/audience-sends.json), when (now, at a time, each new person who joins) and one price or two to test, then send
//   through tool:send-to-an-audience, the same tool an AI runs. After sending it reads how it went, per price.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Channels, timings and every word come from src/audience-sends.json; adding a channel is a row there.
//   2. The send goes through the Workshop tool, never a route of its own.
//   3. Only shared parts draw it (parts/ui).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button, Container, Input, NamedIcon, SegmentedControl, Text, Textarea } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { Dropdown } from '../../parts/ui';
import { ChoiceList } from '../../parts/ui/show/choice-list';
import { ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { readLists } from './list-records';
import { openScreen } from './open-screen';
import { runWorkshopTool } from './workshop-tool-api';

type ListRow = { id: string; label: string; rows?: number; views?: { id: string; label: string }[] };
type PriceGroup = { arm: string | null; price: string | null; sent: number; opened: number; signed: number; paid: number; money_cents?: number };
type Results = { send: { id: string; state: string; title: string }; totals: { people: number; sent: number; skipped: number; failed: number }; by_price: PriceGroup[] };
type Saved = { send: { id: string }; sent?: number; failed?: number; remaining?: number; said?: string; matching?: number };

type AudienceChoice = { id: string; label: string; icon: string };
export type AudienceSendContent = {
  channels: { id: string; label: string; needs?: string }[];
  timings: string[];
  screen: { who?: AudienceChoice[]; when?: AudienceChoice[]; prices?: AudienceChoice[]; words?: Record<string, string>; channel_icons?: Record<string, string> };
};
const cents = (dollars: string) => Math.round(Number(dollars) * 100);
const money = (value: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(value / 100);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Container as="label" layout="vertical" gap="xs" className="min-w-0">
      <Text as="span" variant="label" color="muted">{label}</Text>
      {children}
    </Container>
  );
}

function Part({ icon, title, line, children }: { icon: string; title: string; line?: string; children: React.ReactNode }) {
  return (
    <Container layout="vertical" gap="sm" className="min-w-0">
      <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0">
        <NamedIcon name={icon} size="sm" />
        <Container layout="vertical" gap="none" className="min-w-0">
          <Text as="span" variant="body" weight="medium" color="strong">{title}</Text>
          {line && <Text as="span" variant="caption" color="muted">{line}</Text>}
        </Container>
      </Container>
      {children}
    </Container>
  );
}

/** prepare saves the deal and answers its record id; price is the deal's own price in cents. */
export function SendToAnAudience({ prepare, price, currency, note, content, screens }: { prepare: () => Promise<string>; price: number; currency: string; note: string; content: AudienceSendContent; screens: { lists?: string } }) {
  const SCREEN = content.screen;
  const WORDS = SCREEN.words ?? {};
  const CHANNELS = content.channels.map(row => ({ id: row.id, label: row.label, icon: SCREEN.channel_icons?.[row.id], detail: row.needs }));
  const timings = (SCREEN.when ?? []).filter(row => content.timings.includes(row.id));
  const [lists, setLists] = React.useState<ListRow[] | null>(null);
  const [listId, setListId] = React.useState('');
  const [viewId, setViewId] = React.useState('');
  const [channels, setChannels] = React.useState<string[]>(() => CHANNELS[0] ? [CHANNELS[0].id] : []);
  const [when, setWhen] = React.useState(() => timings[0]?.id ?? '');
  const [at, setAt] = React.useState('');
  const [prices, setPrices] = React.useState('one');
  const [first, setFirst] = React.useState(price ? String(price / 100) : '');
  const [second, setSecond] = React.useState(price ? String(Math.round(price * 1.5) / 100) : '');
  const [words, setWords] = React.useState(note);
  const [sendId, setSendId] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Results | null>(null);
  const [doneWords, setDoneWords] = React.useState<string>(WORDS.sent ?? '');

  React.useEffect(() => {
    readLists().then(kept => {
      setLists(kept);
      if (kept[0]) setListId(current => current || kept[0].id);
    }).catch(() => setLists([]));
  }, []);
  React.useEffect(() => { setFirst(price ? String(price / 100) : ''); setSecond(price ? String(Math.round(price * 1.5) / 100) : ''); }, [price]);

  const list = lists?.find(item => item.id === listId) ?? null;
  const read = React.useCallback(async (id: string) => {
    const answer = await runWorkshopTool<Results>('tool:send-to-an-audience', { operation: 'results', send_id: id });
    if (!answer.result) throw new Error(answer.error || 'How it went could not be read.');
    setResults(answer.result);
  }, []);

  const send = async () => {
    if (!listId) throw new Error(WORDS.no_list_chosen);
    if (!channels.length || channels.some(id => !CHANNELS.some(row => row.id === id))) throw new Error(WORDS.no_channel);
    if (!timings.some(row => row.id === when)) throw new Error(WORDS.no_time);
    if (when === 'at' && !at) throw new Error(WORDS.no_time);
    if (prices === 'two' && !(cents(first) > 0 && cents(second) > 0)) throw new Error(WORDS.no_prices);
    try {
      const record = await prepare();
      const answer = await runWorkshopTool<Saved>('tool:send-to-an-audience', {
        operation: 'save', record, audience: [{ list_id: listId, ...(viewId ? { view_id: viewId } : {}) }], channels,
        when: when === 'at' ? { kind: 'at', at: new Date(at).toISOString() } : when,
        ...(prices === 'two' ? { prices: [cents(first), cents(second)], currency } : {}),
        ...(words.trim() ? { note: words.trim() } : {}),
      });
      if (!answer.result?.send?.id) throw new Error(answer.error || 'It could not be sent.');
      setSendId(answer.result.send.id);
      await read(answer.result.send.id);
      const saved = answer.result;
      if (when !== 'now') setDoneWords(when === 'at' ? WORDS.scheduled : WORDS.saved);
      else if (saved.sent === 0 && (saved.failed ?? 0) > 0) throw new Error(saved.said || WORDS.none_sent);
      else if ((saved.failed ?? 0) > 0 || (saved.remaining ?? 0) > 0) setDoneWords(WORDS.partly_sent);
      else setDoneWords(WORDS.sent);
    } catch (error) {
      throw new Error(errorWords(error, 'It could not be sent.'));
    }
  };

  const groups: Listing[] = (results?.by_price ?? []).map(group => ({
    id: group.arm ?? 'one', form: 'row', icon: 'Tag', title: group.price ?? WORDS.one_price,
    value: String(group.paid), unit: ` ${(WORDS.fact_paid ?? '').toLowerCase()}`,
    facts: [
      { label: WORDS.fact_sent, value: String(group.sent), icon: 'Send' },
      { label: WORDS.fact_opened, value: String(group.opened), icon: 'Eye' },
      { label: WORDS.fact_signed, value: String(group.signed), icon: 'PenLine' },
      ...(group.money_cents ? [{ label: 'Money', value: money(group.money_cents, currency), icon: 'Banknote' }] : []),
    ],
  }));

  if (!SCREEN.words || !SCREEN.when?.length || !SCREEN.prices?.length) return null;

  if (lists && !lists.length) {
    return (
      <Container layout="vertical" gap="sm">
        <Text variant="body" color="muted">{WORDS.no_lists}</Text>
        <Container layout="horizontal"><Button variant="secondary" size="sm" disabled={!screens.lists} onClick={() => { if (screens.lists) openScreen(screens.lists); }}><NamedIcon name="List" size="xs" />{WORDS.make_list}</Button></Container>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="lg" className="min-w-0">
      <Part icon="Users" title={WORDS.list_title} line={WORDS.list_line}>
        <Container layout="grid" gap="md" className="grid-cols-1 @min-[520px]:grid-cols-2">
          <Field label={WORDS.pick_list}>
            <Dropdown items={(lists ?? []).map(item => ({ value: item.id, label: item.label, description: item.rows !== undefined ? `${item.rows} people` : undefined, icon: 'List' }))} value={listId} onValueChange={value => { setListId(value); setViewId(''); }} />
          </Field>
          <Field label={WORDS.pick_view}>
            <Dropdown items={[{ value: '', label: WORDS.pick_view }, ...(list?.views ?? []).map(view => ({ value: view.id, label: view.label }))]} value={viewId} onValueChange={setViewId} />
          </Field>
        </Container>
      </Part>
      <Part icon="Send" title={WORDS.how_title} line={WORDS.how_line}>
        <ChoiceList label={WORDS.how_title} items={CHANNELS} chosen={channels.filter(id => CHANNELS.some(row => row.id === id))} onToggle={id => setChannels(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))} />
      </Part>
      <Part icon="CalendarClock" title={WORDS.when_title} line={when === 'each_new' ? WORDS.each_new_line : undefined}>
        <SegmentedControl ariaLabel={WORDS.when_title} value={timings.some(row => row.id === when) ? when : ''} onValueChange={setWhen} items={timings.map(item => ({ id: item.id, label: item.label, icon: <NamedIcon name={item.icon} size="xs" /> }))} className="h-10 w-max max-w-full" />
        {when === 'at' && <Field label={WORDS.at_label}><DateTimePicker aria-label={WORDS.at_label} value={at} onChange={next => setAt(next ?? '')} /></Field>}
      </Part>
      <Part icon="Tag" title={WORDS.price_title} line={prices === 'two' ? WORDS.price_line : undefined}>
        <SegmentedControl ariaLabel={WORDS.price_title} value={prices} onValueChange={setPrices} items={SCREEN.prices.map(item => ({ id: item.id, label: item.label, icon: <NamedIcon name={item.icon} size="xs" /> }))} className="h-10 w-max max-w-full" />
        {prices === 'two' && (
          <Container layout="grid" gap="md" className="grid-cols-2">
            <Field label={WORDS.price_a}><Input type="number" min="1" step="0.01" value={first} onChange={event => setFirst(event.target.value)} /></Field>
            <Field label={WORDS.price_b}><Input type="number" min="1" step="0.01" value={second} onChange={event => setSecond(event.target.value)} /></Field>
          </Container>
        )}
      </Part>
      <Field label={WORDS.note_label}><Textarea rows={3} value={words} placeholder={WORDS.note_placeholder} onChange={event => setWords(event.target.value)} /></Field>
      <Container layout="horizontal" wrap gap="sm">
        <Button variant="primary" onClick={send} disabled={!channels.length || !timings.some(row => row.id === when)} pendingLabel={WORDS.sending} doneLabel={doneWords} errorLabel={WORDS.failed}><NamedIcon name="Send" size="sm" />{WORDS.send}</Button>
      </Container>
      {results && sendId && (
        <Part icon="ChartColumn" title={WORDS.results_title} line={`${WORDS.fact_sent} ${results.totals.sent}${results.totals.skipped ? ` · ${results.totals.skipped} ${WORDS.skipped}` : ''}${results.totals.failed ? ` · ${results.totals.failed} ${WORDS.failed_people}` : ''}`}>
          <ListingGrid label={WORDS.results_title} listings={groups} className="gap-1.5" />
          <Container layout="horizontal" wrap gap="xs">
            <Button variant="ghost" size="sm" onClick={() => read(sendId)}><NamedIcon name="RefreshCw" size="xs" />{WORDS.refresh}</Button>
            {results.send.state !== 'stopped' && results.send.state !== 'sent' && (
              <Button variant="ghost" size="sm" onClick={async () => { await runWorkshopTool('tool:send-to-an-audience', { operation: 'stop', send_id: sendId }); await read(sendId); }}><NamedIcon name="CircleStop" size="xs" />{WORDS.stop}</Button>
            )}
          </Container>
        </Part>
      )}
    </Container>
  );
}
