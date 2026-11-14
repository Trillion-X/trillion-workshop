// parts/ui/show/listing-card/ListingCard.tsx
//
// PURPOSE
//   The one "glance" shape for a thing: a summary a person reads at a glance instead of a list of labelled fields. The
//   thing's own icon, face or logo leads; its name is the title; when it happened (and who made it) sits muted under the
//   title; the one value that matters (a price, a count, a score) stands alone on the right, big, with its unit small
//   (`$437` `/night`); everything else is icon-led facts in one row and chips (people with their faces, companies with
//   their logos, things with their kind's icon, field chips that open into their details). State is a tinted lead tile
//   or a coloured dot, never a sentence. Besides that, a card may carry two lines of what it does, a badge a person
//   should notice (Yours, Published), one signal line with a tone (how it went for people), a cover band with its
//   picture (or a quiet fill until it has one) with the icon set over its lower edge, or with the thing's own opening
//   lines as a sheet (a draft as it reads), the people in it as an
//   overlapping avatar group, and a row of its own buttons (Join, Decline, Do this for me) for a card that is answered
//   rather than opened.
//   Two forms from DATA: `card` (the default, laid in a grid) and `row` (one line: lead, title, a muted note, chips, the
//   mark and the key value on the right), for notices, notes in a list and steps in a timeline. `ListingGrid` lays any
//   number of them out: cards in a grid that fills its width, rows across the whole width. Used by every screen that
//   shows a thing to scan or pick (the Workshop's tools, the Marketplace, Spaces, Home's lists), so the same thing reads
//   the same everywhere.
//
// PROVENANCE
//   Anatomy from real directories: Supabase's Integrations grid (icon top left, state top right, name, one-line
//   description, chips at the foot: mobbin.com/screens/0145cf1c-cb24-4847-950b-0cad19752087), Perplexity's connector
//   cards (mobbin.com/screens/de0d9c72-9791-49c0-9a99-c1081c3a51f3), and 21st.dev's Recipe Card (component 22103:
//   bold name, description clamped to two lines, a divided footer carrying a count). The glance header (lead, title,
//   when under it, key value alone on the right with a small unit, icon-led facts in one row, names as chips with their
//   faces) follows the visual-hierarchy sheets the team picked on 2026-10-01. Written fresh against the coss tokens the workspace already uses; no source was copied.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a kind of listing, a maker, a place, a field or a state. Every word, icon name, unit,
//      chip and tone is the caller's DATA; a tone is one of the plain tone words (good, attention, bad, info, quiet),
//      coloured by screen-look/show/listing-card.css the same way the guide colours its status badges.
//   2. With `onOpen` a press anywhere on the card opens its thing. Without buttons the whole card is its one control (a
//      press, Enter or Space opens it, announced as a link named by its title). With `actions` as well, its buttons are
//      secondary controls beside that press: a press on the card's body still opens it, the title is the link a
//      keyboard reaches (Enter or Space opens it), and each button stays its own control, so no control sits inside
//      another. On an opened card a button, a chip or the caller's `controls` keep their press to themselves; on any
//      other card a press passes on (a row that is a hover form's trigger opens it).
//   3. Every card in a row is the same height, and its text never overflows: the name stops after two lines and the
//      note truncates, the description stops after two lines, facts and chips wrap inside the card and a fact's value stops after two lines (its whole value is its tooltip). A row is one line:
//      everything in it truncates or drops out of sight rather than wrapping (on a phone its facts give way to the title
//      and its chips shrink); its buttons stay on that line while the title keeps at least 16rem, and drop under it otherwise.
//      Parts are set apart by space, never by a rule between them.
//   4. A card far off screen costs no layout (content-visibility), so a grid of thousands scrolls like a grid of ten.
//   5. Every optional field is optional: a listing with only an id and a title still draws a whole card and a whole row.
//      A card always leads with its tile (the quiet box until it has an icon); a row draws a lead only when it has an
//      icon, a picture or a tone, so a plain list of words stays plain.
//   6. Work still going on (`progress` given) shows on the lead tile itself: a ring that fills with how far it has got,
//      announced as a progress bar, or the one loading mark (parts/ui/show/loading-mark) while that is not known.

import React from 'react';
import { NamedIcon } from '../icon';
import { cn } from '../cn';
import { Button } from '../coss/ui/button';
import { AvatarGroup, type AvatarGroupItem } from '../avatar-group/AvatarGroup';
import { PersonTag } from '../person-tag/PersonTag';
import { RecordChip } from '../record-chip/RecordChip';
import { FactChips, type FactChipsProps } from '../fact-chips';
import { LoadingMark } from 'trillion-workshop/tools/ui/show/loading-mark/index.ts';
import { LazyShippedProviderMark } from '../provider-mark/lazy-provider-mark';

/** A labelled fact on a card, like where it runs or what it costs. The icon says what it is; the label is read aloud. */
export type ListingFact = { label: string; value: string; icon?: string };
/** Words with a tone word (good, attention, bad, info, quiet). */
export type ListingTone = { label: string; tone?: string };
/** A button on a card that is answered rather than opened. */
/** `danger` draws the action's icon in the look's destructive colour (a Stop). */
export type ListingAction = { id: string; label: string; icon?: string; primary?: boolean; danger?: boolean };
/** The band across a card's top: its picture, or a quiet fill (with `letters` set large in it) until it has one.
 *  `colour` is a palette id the fill wears, painted by screen-look (`[data-colour]`) in the current look. `page` is
 *  the thing's own opening as it reads (a draft, a document, a script), drawn as a sheet rising out of the band, the
 *  first line as its heading; the card then leads with its tile beside the title. */
export type ListingCover = { picture?: string | null; letters?: string; colour?: string | null; page?: string[] };
/** A name inside the card drawn as a chip. With `kind` it is a thing of that kind (record-chip: the kind's icon and
 *  colour from the caller's RecordChipProvider, opening `href` when it has one); with `tone` and no kind it is a state,
 *  a pill in that tone's colour with its words (and its `icon` when given); otherwise someone or something with a face
 *  or a logo (person-tag: the `picture`, or initials until it has one). `arrow` draws an arrow before the chip, so a
 *  change of state reads `chip -> chip`. */
export type ListingChip = { label: string; picture?: string | null; kind?: string; value?: string; icon?: string; colour?: string; href?: string; tone?: string; arrow?: boolean };
/** Who is doing it, drawn as the lead instead of an icon: the provider's mark when `provider` names one the shipped
 *  registry knows, else the `picture`, else their initials on their own colour. `working` circles the face with a
 *  turning arc, so the face itself says whether they are at it now. */
export type ListingFace = { name: string; picture?: string | null; provider?: string | null; working?: boolean };
/** Field chips (fact-chips): field descriptors with `chip` placements and the thing's values; each opens on hover. */
export type ListingFactChips = Pick<FactChipsProps, 'fields' | 'facts' | 'valueLabels' | 'valueIcons' | 'label'>;
/** One thing, as DATA. */
export type Listing = {
  id: string;
  title: string;
  /** `card` (the default) or `row`: one line, for notices, notes in a list and steps in a timeline. */
  form?: 'card' | 'row';
  /** Who made it or where it comes from. */
  byline?: string;
  /** When it happened or is due, already in words ("Today 9:30am"), muted under the title. */
  when?: string;
  /** What it does, in the maker's words. */
  text?: string;
  /** A NamedIcon name. */
  icon?: string;
  /** The thing's own face or logo, drawn in the lead tile instead of the icon (the icon returns if it does not load). */
  picture?: string | null;
  /** Where it belongs or goes, as a provider-icon slug (x, youtube): that mark leads in place of the icon when the
   *  shipped registry knows it. */
  logo?: string;
  /** Who is doing it, leading the card or row in place of the icon (and the picture). */
  face?: ListingFace;
  /** A row that shows its whole title, wrapping as it needs, with when and the note on one quiet line under it, instead
   *  of truncating everything onto one line. For a row a person must read in full at a glance (work they sent). */
  whole?: boolean;
  /** The lead tile's tint, a tone word: the state of the thing at a glance. */
  tone?: string;
  /** A state as a coloured dot; its words show on hover and are read aloud. */
  mark?: ListingTone;
  /** The one value that matters, alone on the right ("$437", "12"). */
  value?: string;
  /** The value's unit, drawn small after it ("/night", "new"). */
  unit?: string;
  /** Words a screen reader says for the value when the value and unit alone are not enough ("12 new things"). */
  valueLabel?: string;
  /** A state a person should notice, drawn in the top corner. */
  badge?: ListingTone;
  facts?: ListingFact[];
  /** Names drawn as chips with their face, logo or kind. */
  chips?: ListingChip[];
  /** Field chips that open into their details. */
  factChips?: ListingFactChips;
  /** One line at the foot with a tone dot: how it has gone. */
  signal?: ListingTone;
  /** A band across the top with the picture; the icon sits over its lower edge. */
  cover?: ListingCover;
  /** The people in it, as an overlapping avatar group at the foot. */
  people?: AvatarGroupItem[];
  /** Words a screen reader says for the people ("Ana, Ben and you"). */
  peopleLabel?: string;
  /** The card's own buttons, for a card answered rather than opened. */
  actions?: ListingAction[];
  /** Work on it still going on: how far it has got, 0 to 1, or null while that is not known yet. Left out when the thing
   *  is not working. */
  progress?: number | null;
};

export type ListingCardProps = {
  listing: Listing;
  onOpen?: (id: string) => void;
  onAction?: (id: string, action: string) => void;
  /** The caller's own controls drawn after the card's buttons (a part that is not DATA, such as an ask-my-AI button). */
  controls?: React.ReactNode;
  /** Caller-owned content between the short description and the icon-led facts (for a task's primary action). */
  content?: React.ReactNode;
  className?: string;
};

const RING_RADIUS = 17;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** How far work has got, around the lead tile: a ring that fills, or the loading mark while that is not known. */
function WorkRing({ listing }: { listing: Listing }) {
  const value = listing.progress;
  if (value === undefined) return null;
  if (value === null) return <span data-listing-working="" data-progress="indeterminate" aria-hidden className="absolute inset-0 flex items-center justify-center bg-inherit"><LoadingMark size="sm" /></span>;
  const share = Math.max(0, Math.min(1, value));
  return (
    <svg data-listing-ring="" viewBox="0 0 40 40" role="progressbar" aria-label={listing.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="pointer-events-none absolute inset-0 size-full -rotate-90 overflow-visible">
      <circle data-listing-ring-track="" cx="20" cy="20" r={RING_RADIUS} />
      <circle data-listing-ring-value="" cx="20" cy="20" r={RING_RADIUS} strokeDasharray={RING_LENGTH} strokeDashoffset={RING_LENGTH * (1 - share)} />
    </svg>
  );
}

/** Who is doing it, as the lead tile: the provider's mark when the shipped registry knows it, else their picture, else
 *  their initials, drawn by person-tag; while they work, a short stroke runs around the tile's edge (screen-look listing-card.css). */
function FaceTile({ face, small }: { face: ListingFace; small?: boolean }) {
  const person = <PersonTag name={face.name} picture={face.picture ?? null} size="md" />;
  return (
    <span data-listing-face="" title={face.name} className={cn('relative flex shrink-0 items-center justify-center border bg-muted/64', small ? 'size-8 rounded-lg' : 'size-10 rounded-xl')}>
      {face.provider ? <LazyShippedProviderMark providerSlug={face.provider} providerName={face.name} size={small ? 'sm' : 'md'} fallback={person} /> : person}
      {face.working ? (
        <svg data-listing-arc="" aria-hidden viewBox="0 0 40 40" className="pointer-events-none absolute -inset-1 size-[calc(100%+0.5rem)] overflow-visible">
          <rect data-listing-arc-track="" x="1.5" y="1.5" width="37" height="37" rx="10" pathLength={100} />
          <rect data-listing-arc-value="" x="1.5" y="1.5" width="37" height="37" rx="10" pathLength={100} strokeDasharray="22 78" />
        </svg>
      ) : null}
    </span>
  );
}

function LeadTile({ listing, small, onCover }: { listing: Listing; small?: boolean; onCover?: boolean }) {
  const [pictureFailed, setPictureFailed] = React.useState(false);
  React.useEffect(() => setPictureFailed(false), [listing.picture]);
  if (listing.face) return <FaceTile face={listing.face} small={small} />;
  const picture = listing.picture && !pictureFailed ? listing.picture : null;
  const plain = picture ? <img src={picture} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setPictureFailed(true)} />
    : <NamedIcon name={listing.icon} fallback="Box" size="sm" aria-hidden />;
  return (
    <span
      aria-hidden={listing.progress === undefined || listing.progress === null}
      data-listing-tile=""
      data-working={listing.progress !== undefined || undefined}
      data-tone={listing.tone}
      className={cn(
        'relative flex shrink-0 items-center justify-center border bg-muted/64 text-foreground/80',
        listing.progress === undefined && 'overflow-hidden',
        small ? 'size-8 rounded-lg' : 'size-10 rounded-xl',
        onCover && 'bg-card shadow-xs/5',
      )}
    >
      {listing.logo ? <LazyShippedProviderMark providerSlug={listing.logo} providerName={listing.title} size={small ? 'sm' : 'md'} needsImage fallback={plain} /> : plain}
      <WorkRing listing={listing} />
    </span>
  );
}

function Badge({ badge }: { badge: ListingTone }) {
  return <span data-listing-badge="" data-tone={badge.tone ?? 'quiet'}><span data-listing-dot="" aria-hidden />{badge.label}</span>;
}

function Mark({ mark }: { mark: ListingTone }) {
  return <span data-listing-dot="" data-listing-mark="" data-tone={mark.tone ?? 'quiet'} role="img" aria-label={mark.label} title={mark.label} />;
}

function KeyValue({ listing, small }: { listing: Listing; small?: boolean }) {
  if (!listing.value) return null;
  return (
    <p data-listing-value="" aria-label={listing.valueLabel} className={cn('flex shrink-0 items-baseline gap-0.5 whitespace-nowrap font-semibold tabular-nums text-foreground', small ? 'text-sm' : 'text-lg leading-6')}>
      <span>{listing.value}</span>
      {listing.unit ? <span data-listing-unit="" className="text-xs font-normal text-muted-foreground">{listing.unit}</span> : null}
    </p>
  );
}

/** The chips: names with their face, logo or kind, then the field chips. A chip that opens something keeps the press. */
function Chips({ listing, row, stop }: { listing: Listing; row?: boolean; stop?: boolean }) {
  if (!listing.chips?.length && !listing.factChips) return null;
  return (
    <div data-listing-chips="" className={cn('min-w-0 items-center gap-1.5', row ? 'flex max-w-[45%] shrink flex-nowrap overflow-hidden' : 'flex flex-wrap')} onClick={stop ? event => event.stopPropagation() : undefined} onKeyDown={stop ? event => event.stopPropagation() : undefined}>
      {listing.chips?.map((chip, index) => (
        <React.Fragment key={`${index}:${chip.label}`}>
          {chip.arrow ? <NamedIcon name="ArrowRight" size="xs" aria-hidden className="shrink-0 text-muted-foreground" /> : null}
          {!chip.kind && chip.tone ? (
            <span data-listing-chip="" data-tone={chip.tone} className="inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium">
              {chip.icon ? <NamedIcon name={chip.icon} size="xs" aria-hidden className="shrink-0" /> : null}
              <span className="truncate" title={chip.label}>{chip.label}</span>
            </span>
          ) : (
            <span data-listing-chip="" className="inline-flex min-w-0 shrink-0 items-center rounded-full bg-muted/64 py-0.5 pr-2 pl-0.5 text-xs">
              {chip.kind
                ? <RecordChip kind={chip.kind} value={chip.value ?? chip.label} label={chip.label} icon={chip.icon} colour={chip.colour} href={chip.href} still={!chip.href} />
                : <PersonTag name={chip.label} picture={chip.picture ?? null} size="xs" showName />}
            </span>
          )}
        </React.Fragment>
      ))}
      {listing.factChips ? <FactChips {...listing.factChips} /> : null}
    </div>
  );
}

function Facts({ facts }: { facts: ListingFact[] }) {
  return (
    <ul data-listing-facts="" className="flex min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-xs text-muted-foreground">
      {facts.map(fact => (
        <li key={fact.label} className="flex min-w-0 max-w-full items-center gap-1" title={`${fact.label}: ${fact.value}`}>
          <NamedIcon name={fact.icon} fallback="Dot" size="xs" aria-hidden className="shrink-0 opacity-70" />
          <span className="sr-only">{fact.label}: </span>
          <span className="line-clamp-2 min-w-0 break-words text-foreground/80">{fact.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Actions({ listing, onAction, controls, className, stop }: { listing: Listing; onAction?: ListingCardProps['onAction']; controls?: React.ReactNode; className?: string; stop?: boolean }) {
  if (!listing.actions?.length && !controls) return null;
  return (
    <div data-slot="listing-actions" className={cn('flex flex-wrap items-center gap-2', className)} onClick={stop ? event => event.stopPropagation() : undefined}>
      {listing.actions?.map(action => (
        <Button key={action.id} type="button" size="sm" variant={action.primary ? 'default' : 'outline'} onClick={() => onAction?.(listing.id, action.id)}>
          {action.icon ? <NamedIcon name={action.icon} size="sm" className={action.danger ? 'fill-current text-destructive-foreground' : undefined} aria-hidden="true" /> : null}
          {action.label}
        </Button>
      ))}
      {controls}
    </div>
  );
}

const note = (listing: Listing) => [listing.byline, listing.when].filter(Boolean).join(' · ');

export function ListingCard({ listing, onOpen: openCard, onAction, controls, content, className }: ListingCardProps) {
  const onOpen = openCard;
  const open = () => onOpen?.(listing.id);
  // Opened and answered both (invariant 2): the body opens, the title is the keyboard's link, the buttons stay their own.
  const withButtons = Boolean(onOpen && listing.actions?.length);
  const keys = (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } };
  const titleLink = withButtons ? { role: 'link', tabIndex: 0, onKeyDown: keys, className: 'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring' } : null;
  const row = listing.form === 'row';
  const [pictureFailed, setPictureFailed] = React.useState(false);
  const picture = listing.cover?.picture && !pictureFailed ? listing.cover.picture : null;
  const sub = note(listing);
  const shared = {
    'data-slot': 'listing-card',
    'data-form': row ? 'row' : 'card',
    'data-listing-id': listing.id,
    role: onOpen && !withButtons ? 'link' : undefined,
    tabIndex: onOpen && !withButtons ? 0 : undefined,
    'aria-label': onOpen && !withButtons ? listing.title : undefined,
    'data-opens': onOpen ? '' : undefined,
    onClick: onOpen ? open : undefined,
    onKeyDown: onOpen && !withButtons ? keys : undefined,
  };
  const pressable = onOpen && 'cursor-pointer outline-none hover:border-ring/40 hover:shadow-md/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:translate-y-px';

  if (row && listing.whole) {
    // A row read in full at a glance: the face (or tile), the whole title wrapping as it needs, and one quiet line under
    // it with how far it has got and when. With `onOpen` the whole row is its one control.
    const line = [listing.text, sub].filter(Boolean).join(' · ');
    return (
      <article {...shared} data-whole="" className={cn('group/listing relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow,transform]', pressable, className)}>
        <div data-listing-line="" className="flex min-w-[min(16rem,100%)] flex-1 items-center gap-3">
          {listing.face || listing.icon || listing.logo || listing.picture || listing.tone ? <LeadTile listing={listing} small /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p data-listing-title="" className="text-sm font-medium leading-5 break-words"><span {...titleLink}>{listing.title}</span></p>
            {line ? <p data-listing-note="" className="text-xs text-muted-foreground break-words">{line}</p> : null}
          </div>
          <Chips listing={listing} row stop={Boolean(onOpen)} />
          {listing.badge ? <Badge badge={listing.badge} /> : null}
          <KeyValue listing={listing} small />
          {controls && !listing.actions?.length ? <span data-slot="listing-controls" className="flex shrink-0 items-center" onClick={onOpen ? event => event.stopPropagation() : undefined}>{controls}</span> : null}
        </div>
        {listing.actions?.length ? <Actions listing={listing} onAction={onAction} controls={controls} className="ml-auto shrink-0 flex-nowrap" stop={Boolean(onOpen)} /> : null}
      </article>
    );
  }

  if (row) {
    return (
      <article {...shared} className={cn('group/listing relative flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 overflow-hidden rounded-xl border bg-card px-3 py-1.5 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow,transform] [contain-intrinsic-size:auto_3rem] [content-visibility:auto]', pressable, className)}>
        <div data-listing-line="" className="flex h-9 min-w-[min(16rem,100%)] flex-1 items-center gap-3">
          {listing.icon || listing.logo || listing.picture || listing.tone ? <LeadTile listing={listing} small /> : null}
          {/* The title gives way before the when is cut, and the note shows only where the line has room for it
              (22rem), never as a sliver of one letter. */}
          <p className="@container/line flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap text-sm">
            <span className="min-w-0 max-w-[75%] truncate font-medium" title={listing.title}><span {...titleLink}>{listing.title}</span></span>
            {sub ? <span data-listing-when="" className="shrink-0 border-l pl-2 text-xs text-muted-foreground">{sub}</span> : null}
            {listing.text ? <span data-listing-note="" className="hidden min-w-0 shrink-[4] truncate text-xs text-muted-foreground @[22rem]/line:inline" title={listing.text}>{listing.text}</span> : null}
          </p>
          <Chips listing={listing} row stop={Boolean(onOpen)} />
          {listing.facts?.length ? <span className="hidden shrink-0 whitespace-nowrap sm:flex"><Facts facts={listing.facts} /></span> : null}
          {listing.mark ? <Mark mark={listing.mark} /> : null}
          {listing.signal ? <span className="flex shrink-0 items-center gap-1.5 text-xs" data-tone={listing.signal.tone ?? 'quiet'}><span data-listing-dot="" aria-hidden /><span className="max-w-40 truncate text-foreground/80">{listing.signal.label}</span></span> : null}
          {listing.badge ? <Badge badge={listing.badge} /> : null}
          {listing.people?.length ? <span className="shrink-0"><AvatarGroup items={listing.people} size="sm" max={3} ariaLabel={listing.peopleLabel} /></span> : null}
          <KeyValue listing={listing} small />
          {/* A row's own controls with no buttons beside them (a Take out) stay on its one line at any width. */}
          {controls && !listing.actions?.length ? <span data-slot="listing-controls" className="flex shrink-0 items-center" onClick={onOpen ? event => event.stopPropagation() : undefined}>{controls}</span> : null}
        </div>
        {listing.actions?.length ? <Actions listing={listing} onAction={onAction} controls={controls} className="ml-auto shrink-0 flex-nowrap" stop={Boolean(onOpen)} /> : null}
      </article>
    );
  }

  const page = listing.cover?.page?.filter(Boolean) ?? [];
  // A picture band carries the tile over its lower edge; a page band leaves the tile beside the title.
  const lead = !listing.cover || page.length > 0;
  const foot = listing.facts?.length || listing.signal || listing.people?.length;
  return (
    <article {...shared} className={cn('group/listing relative flex h-full min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border bg-card p-4 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow,transform] [contain-intrinsic-size:auto_12rem] [content-visibility:auto]', pressable, className)}>
      {listing.cover ? (
        <div data-slot="listing-cover" data-colour={listing.cover.colour ?? undefined} className={cn('relative -mx-4 -mt-4 shrink-0 overflow-hidden bg-muted/64', page.length ? 'h-36' : 'mb-2 h-24')}>
          {page.length ? (
            <div data-slot="listing-page" className="absolute inset-x-5 top-4 -bottom-px flex flex-col gap-1.5 rounded-t-lg border border-b-0 bg-card px-3.5 pt-3 shadow-sm/5 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
              {page.map((line, index) => (
                <p key={index} className={cn('line-clamp-2 shrink-0 break-words leading-4', index ? 'text-[0.6875rem] text-muted-foreground' : 'text-xs font-semibold text-foreground')}>{line}</p>
              ))}
            </div>
          ) : picture ? <img src={picture} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setPictureFailed(true)} />
            : listing.cover.letters ? <span aria-hidden data-slot="listing-cover-letters" className="flex size-full items-center justify-center font-semibold text-3xl tracking-wide text-foreground/25 select-none">{listing.cover.letters}</span> : null}
          {page.length ? null : <span className="absolute -bottom-5 left-4"><LeadTile listing={listing} onCover /></span>}
          {listing.badge && !lead ? <span className="absolute top-3 right-3"><Badge badge={listing.badge} /></span> : null}
        </div>
      ) : null}
      <div data-listing-head="" className="flex min-w-0 flex-wrap items-start gap-3">
        {lead ? <LeadTile listing={listing} /> : null}
        <div className={cn('flex min-w-32 flex-1 flex-col gap-0.5', lead && 'min-h-10 justify-center')}>
          <h3 className="line-clamp-2 text-sm font-semibold leading-5" title={listing.title}><span {...titleLink}>{listing.title}</span></h3>
          {sub ? <p data-listing-when="" className="truncate text-xs text-muted-foreground">{sub}</p> : null}
        </div>
        {listing.value || listing.mark || (lead && listing.badge) ? (
          <div data-listing-side="" className="ml-auto flex shrink-0 flex-col items-end gap-1">
            <span className="flex items-center gap-2">
              {listing.mark ? <Mark mark={listing.mark} /> : null}
              <KeyValue listing={listing} />
            </span>
            {lead && listing.badge ? <Badge badge={listing.badge} /> : null}
          </div>
        ) : null}
      </div>
      {listing.text ? <p className="line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground" title={listing.text}>{listing.text}</p> : null}
      {content ? <div data-listing-content="">{content}</div> : null}
      <Chips listing={listing} stop={Boolean(onOpen)} />
      {foot ? (
        <div className="mt-auto flex min-w-0 flex-col gap-1.5 pt-1">
          {listing.facts?.length ? <Facts facts={listing.facts} /> : null}
          {listing.signal ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs" data-tone={listing.signal.tone ?? 'quiet'}>
              <span data-listing-dot="" aria-hidden />
              <span className="min-w-0 truncate text-foreground/80">{listing.signal.label}</span>
            </p>
          ) : null}
          {listing.people?.length ? (
            <span className="pt-1"><AvatarGroup items={listing.people} size="sm" max={5} ariaLabel={listing.peopleLabel} /></span>
          ) : null}
        </div>
      ) : null}
      <Actions listing={listing} onAction={onAction} controls={controls} className={cn(!foot && 'mt-auto')} stop={Boolean(onOpen)} />
    </article>
  );
}

export type ListingGridProps = {
  listings: Listing[];
  onOpen?: (id: string) => void;
  onAction?: (id: string, action: string) => void;
  /** The caller's own controls for each listing (a Take out button), drawn as `ListingCard` `controls`. */
  controls?: (listing: Listing) => React.ReactNode;
  label: string;
  className?: string;
};

/** Listings as wide as their host: cards in as many columns of at least 16rem as fit (one on a phone); a row form
 *  listing takes the whole width. */
export function ListingGrid({ listings, onOpen, onAction, controls, label, className }: ListingGridProps) {
  return (
    <ul aria-label={label} data-slot="listing-grid" className={cn('grid list-none grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3 p-0', className)}>
      {listings.map(listing => (
        <li key={listing.id} className={cn('min-w-0', listing.form === 'row' && 'col-span-full')}>
          <ListingCard listing={listing} onOpen={onOpen} onAction={onAction} controls={controls?.(listing)} />
        </li>
      ))}
    </ul>
  );
}
