// parts/ui/show/catch-up/CatchUpPanel.tsx
//
// PROVENANCE
//   Devices as one-line rows, each with its own mark, when it last caught up and what waits on it: Tailscale's Machines
//   (last seen beside each machine, mobbin.com/screens), Revolut's and Wise's
//   device rows ("This device" named on the row, mobbin.com/screens/a33d51b9-51c6-46f1-b44f-eb4bc6207346,
//   mobbin.com/screens/95f7ef8e-6705-4d29-8e91-b1edae9c1332). The header (a tinted tile, the state, one line and the
//   state's own actions) follows the visual-hierarchy sheets (rule 1 and rule 5). Rows are the shared ListingCard row
//   form; nothing here draws its own card.
//
// PURPOSE
//   The whole picture of whether everything is in step: the leading state with the actions it offers, every device or
//   other copy as a row (this device first) with its state, when it last caught up, how much waits on it and how far it
//   has got, and every record kept as two versions, each opening its TwoVersions view in place. Every action is a
//   button that says its own work (pending, done, Try again); nothing is told in a separate toast.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: words, tones, icons and actions are the caller's DATA (CatchUpWords); facts and versions come from the
//      page's sources (catch-up.ts).
//   2. An action is the promise the source answers; the button shows it pending, done or failed in itself.
//   3. Only one record's versions are open at a time, in place under its row, never in a dialog over the work.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { IconTile } from '../icon-tile/IconTile';
import { NamedIcon, resolveNamedIcon } from '../icon';
import { ListingCard, type Listing } from '../listing-card';
import { Text } from '../text';
import { relativeWhen } from '../relative-time/relative-time';
import { TwoVersions } from './TwoVersions';
import { catchUpAct, useCatchUp, type CatchUpWords, type ShownFact } from './catch-up';

// The icon tile's tones, from the plain tone words every row carries.
const TILE_TONE: Record<string, 'success' | 'warning' | 'error' | 'info' | 'neutral'> = { good: 'success', attention: 'warning', bad: 'error', info: 'info', quiet: 'neutral' };

function ActionButtons({ words, fact, primary = false, size = 'sm' }: { words: CatchUpWords; fact: ShownFact; primary?: boolean; size?: 'sm' | 'xs' }) {
  if (!fact.offers.length) return null;
  return (
    <>
      {fact.offers.map((id, index) => {
        const action = words.actions?.[id];
        if (!action) return null;
        return (
          <Button
            key={id}
            size={size}
            variant={index === 0 && primary ? 'primary' : 'secondary'}
            pendingLabel={action.pending}
            doneLabel={action.done}
            errorLabel={words.words.try_again}
            data-catch-up-action={id}
            onClick={() => catchUpAct(id, fact)}
          >
            {action.icon ? <NamedIcon name={action.icon} size="sm" /> : null}
            {action.label}
          </Button>
        );
      })}
    </>
  );
}

/** A fact as the shared row: its kind's icon, its name, when it last caught up, its state as a dot and what waits. */
function listingOf(fact: ShownFact, words: CatchUpWords, now: number): Listing {
  const icon = (fact.kind && words.kinds?.[fact.kind]?.icon) || words.kinds?.['']?.icon;
  const when = fact.at !== undefined ? relativeWhen(fact.at, now, { inSentence: true }) : '';
  const measuredShare = typeof fact.total === 'number' && fact.total > 0 && typeof fact.done === 'number' ? fact.done / fact.total : undefined;
  return {
    id: `${fact.source}:${fact.id}`,
    form: 'row',
    whole: true,
    title: fact.title || (fact.here ? words.words.this_device : words.words.other_copy),
    icon,
    tone: fact.row.tone,
    // In step: when it last caught up. Otherwise its state first, then when it last caught up.
    when: fact.row.quiet ? `${words.words.caught_up_when ?? ''} ${when}`.trim() : [fact.words, when && `${words.words.caught_up_when ?? ''} ${when}`.trim()].filter(Boolean).join(' · '),
    mark: { label: fact.words, tone: fact.row.tone },
    ...(fact.here && fact.title ? { badge: { label: words.words.this_device, tone: 'quiet' } } : {}),
    ...(fact.waiting ? { value: String(fact.waiting), unit: words.words.waiting_unit, valueLabel: fact.words } : {}),
    // A ring only for work whose extent is measured; the dot already breathes for the rest.
    ...(measuredShare !== undefined ? { progress: measuredShare } : {}),
  };
}

export function CatchUpPanel({ words }: { words: CatchUpWords }) {
  const view = useCatchUp(words);
  const [openApart, setOpenApart] = React.useState<string | null>(null);
  const now = Date.now();
  const quiet = !view.state || view.row.quiet;
  const title = view.label || words.words.all_in_step;
  const tileIcon = resolveNamedIcon(view.row.icon) ?? resolveNamedIcon('Cloud') ?? undefined;
  return (
    <Container layout="vertical" gap="md" className="catch-up-panel" data-catch-up-panel="" data-tone={view.row.tone}>
      <Container layout="horizontal" gap="md" alignItems="start" data-catch-up-head="">
        <IconTile icon={tileIcon as never} tone={TILE_TONE[view.row.tone ?? 'quiet'] ?? 'neutral'} size="md" glow={!quiet} />
        <Container layout="vertical" gap="xs" className="min-w-0 flex-1">
          <Text variant="heading" weight="semibold">{title}</Text>
          {view.row.detail ? <Text variant="caption">{view.row.detail}</Text> : null}
          {view.lead?.offers.length ? (
            <Container layout="horizontal" gap="sm" wrap="wrap" className="pt-1">
              <ActionButtons words={words} fact={view.lead} primary />
            </Container>
          ) : null}
        </Container>
      </Container>

      {view.facts.length ? (
        <Container layout="vertical" gap="xs" data-catch-up-devices="">
          <Text variant="label">{words.words.devices}</Text>
          {view.facts.map(fact => (
            <ListingCard
              key={`${fact.source}:${fact.id}`}
              listing={listingOf(fact, words, now)}
              controls={fact.offers.length && fact !== view.lead ? <ActionButtons words={words} fact={fact} size="xs" /> : undefined}
            />
          ))}
        </Container>
      ) : null}

      {view.apart.length ? (
        <Container layout="vertical" gap="xs" data-catch-up-apart="">
          <Text variant="label">{words.words.two_versions}</Text>
          {view.apart.map(apart => {
            const id = `${apart.source}:${apart.id}`;
            const open = openApart === id;
            return (
              <Container key={id} layout="vertical" gap="sm" data-catch-up-apart-row="" data-open={open || undefined}>
                <ListingCard
                  listing={{
                    id,
                    form: 'row',
                    whole: true,
                    title: apart.thing.title,
                    icon: words.kinds?.[apart.thing.kind]?.icon ?? words.kinds?.['']?.icon,
                    tone: words.apart_state ? words.states[words.apart_state]?.tone : undefined,
                    when: words.words.apart_when,
                    value: String(apart.sides.length),
                    unit: words.words.versions_unit,
                  }}
                  onOpen={() => setOpenApart(open ? null : id)}
                />
                {open ? <TwoVersions apart={apart} words={words} onSettled={() => setOpenApart(null)} /> : null}
              </Container>
            );
          })}
        </Container>
      ) : null}
    </Container>
  );
}
