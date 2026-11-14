// parts/ui/show/dashboard/Dashboard.tsx
//
// PURPOSE
//   A home to start the day from, drawn entirely from the caller's DATA: a greeting with the one next step, a row of
//   stat cards (each with its line over time), and a grid of cards below: a large chart, lists whose rows answer in
//   place, a feed of what happened, and a gallery of things with their pictures. The anatomy follows 21st.dev's "App
//   Dashboard Layout" (stat cards, a chart card, a progress list and a recent-activity feed) and its "Activity Feed"
//   timeline rows; the gallery follows Descript's Recents (a still, the name, who and when:
//   mobbin.com/screens/75945354-f320-4626-b775-2e069eb49402) and MagicPath's file grid
//   (mobbin.com/screens/a011feb8-3a00-4b41-aa2f-2da05294fdf0).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every label, value, row and feed item is the caller's DATA.
//   2. A row that asks something (`form`) answers in place: hovering the row, or pressing its action, opens the shared
//      hover form (record-views/hover-form.tsx) with what the person needs to answer. Nothing opens a new tab for it.
//   3. A card with nothing in it says so in the caller's words (with the caller's way out, when it gives one); a line
//      with fewer than two points is not drawn.
//   6. A gallery tile's picture is the caller's element (its own preview part); resting the pointer on a tile with a
//      `hover` item opens the shared hover preview (hover-preview), which shows it through the one file preview.
//   4. How a card draws is looked up by its `kind` in CARD_DRAWERS; adding a kind adds one entry there, never a branch.
//   5. Appearance lives in screen-look/show/dashboard.css (`.dashboard-*`); controls are the shared coss parts.
//   7. A card's `form` is a button in its head that opens the shared hover form in place (adding something to the
//      card); a `spotlight` card shows one thing large: a headline, its stages as a thread, a line of why, and the one
//      action or ask-my-AI button that moves it.

import * as React from 'react';
import { Button } from '../coss/ui/button';
import { Badge } from '../coss/ui/badge';
import { Chart } from '../chart/Chart';
import { chartOfPoints } from '../chart/chart-from-records';
import { PersonTag } from '../person-tag/PersonTag';
import { QueueJobButton, type QueueJobButtonProps } from '../queue-job/QueueJobButton';
import { AutomationMarks, type BackingAutomation } from '../automation-preview/AutomationPreview';
import { HoverFormCell, type HoverForm } from '../record-views/hover-form';
import { relativeWhen } from '../relative-time/relative-time';
import { EmptyState } from '../empty-state';
import { ListingCard, type Listing } from '../listing-card';
import { NamedIcon } from '../icon';
import { HoverPreview, type PreviewItem } from '../hover-preview';

export type DashboardAction = { label: string; run: () => void };
export type DashboardPoint = { t: number; value: number };

export type DashboardStat = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  /** Every point oldest first; drawn under the number when there are two or more. */
  points?: DashboardPoint[];
  /** Which way counts as better, so the line is green when it moved that way. */
  better?: 'lower' | 'higher';
  /** How a point reads on hover: seconds or percent; anything else reads as the number. */
  unit?: string;
  /** Pressing the card. */
  open?: DashboardAction;
};

/** A row is drawn in the one glance shape (listing-card, row form), so it takes that shape's fields too: the lead
 *  `icon` or `picture`, its `tone` tint, a `mark` dot, the key `value` with its `unit`, and `chips` with faces. */
export type DashboardRow = Pick<Listing, 'icon' | 'picture' | 'tone' | 'mark' | 'value' | 'unit' | 'chips' | 'whole'> & {
  id: string;
  title: string;
  detail?: string;
  badge?: { label: string; tone?: string };
  /** A short word such as when, muted beside the title. */
  meta?: string;
  /** What the row asks the person; hovering the row or pressing its action opens it in place. */
  form?: HoverForm;
  /** The button on the right. With a form, it opens the form. */
  action?: DashboardAction | { label: string };
  /** A button that asks the person's own AI to do a job about this row (queue-job). */
  queue?: QueueJobButtonProps;
  /** Pressing the row itself (a row with no `action` or `form`): the whole row is its one control. */
  open?: () => void;
};

export type DashboardFeedItem = { id: string; who: string; picture?: string | null; title: string; detail?: string; at: string; tone?: string };

/** One thing in a gallery card: its picture (the caller's element), its name, who made it and when. */
export type DashboardTile = {
  id: string;
  title: string;
  /** The picture, drawn by the caller's own preview part. */
  preview: React.ReactNode;
  who: string;
  whoPicture?: string | null;
  at: string;
  /** A state to notice (like "New"): a solid chip at the start of the title line, never over the picture, whose own
   *  text (a document's opening lines, a still) it would otherwise cover. */
  badge?: { label: string };
  /** What resting the pointer on the tile shows (the one file preview). */
  hover?: PreviewItem;
  open?: () => void;
};

/** `automations`: what runs by itself behind this card, each shown as a mark beside the title with its hover card.
 *  `wide` spans two columns, `'full'` the whole row. An empty card says `empty`, with `emptyDetail`, `emptyIcon` and the
 *  way out `emptyAction` when the caller gives them. */
type CardBase = { id: string; title: string; description?: string; empty?: string; emptyDetail?: string; emptyIcon?: string; emptyAction?: DashboardAction; more?: DashboardAction; form?: DashboardCardForm; wide?: boolean | 'full'; automations?: BackingAutomation[] };
/** A button in a card's head that opens the shared hover form in place, such as adding a row to the card. */
export type DashboardCardForm = { label: string; form: HoverForm };
/** One stage of a spotlight's thread, such as where something is now and where it gets to. */
export type DashboardStage = { label: string; text: string; tone?: 'quiet' | 'accent' };
export type DashboardCard =
  | (CardBase & { kind: 'chart'; points: DashboardPoint[]; better?: 'lower' | 'higher'; unit?: string; value?: string; detail?: string })
  | (CardBase & { kind: 'rows'; rows: DashboardRow[] })
  | (CardBase & { kind: 'feed'; items: DashboardFeedItem[] })
  | (CardBase & { kind: 'gallery'; tiles: DashboardTile[] })
  | (CardBase & { kind: 'spotlight'; headline: string; stages?: DashboardStage[]; detail?: string; action?: DashboardAction; queue?: QueueJobButtonProps });

/** One count under the greeting, drawn as a small tile (its number over its words), never joined into a sentence.
 *  `open` makes the tile a button to the screen that holds those things; `tone` names a badge colour for its number. */
export type DashboardGlance = { id: string; value: string; label: string; tone?: string; open?: DashboardAction };

export type DashboardProps = {
  greeting: string;
  summary?: string;
  /** Counts under the greeting as tiles; the caller's words, order and screens. Shown in place of `summary`. */
  glance?: DashboardGlance[];
  /** Caller-owned action placed directly under the greeting. */
  headerAction?: React.ReactNode;
  next?: { title: string; detail?: string; action?: DashboardAction; form?: HoverForm };
  stats: DashboardStat[];
  cards: DashboardCard[];
};

const toneOf = (points: DashboardPoint[], better?: 'lower' | 'higher') => {
  if (points.length < 2 || !better) return 'neutral' as const;
  const first = points[0].value, last = points[points.length - 1].value;
  if (first === last) return 'neutral' as const;
  return (better === 'higher' ? last > first : last < first) ? 'success' as const : 'error' as const;
};
// A line takes the chart tone its stat moved in: better reads good, worse reads as a warning, flat keeps its colour.
const CHART_TONE = { success: 'good', error: 'warning', neutral: undefined } as const;

function StatCard({ stat }: { stat: DashboardStat }) {
  const points = stat.points ?? [];
  return (
    <div className="dashboard-stat" data-tone={toneOf(points, stat.better)}>
      <div className="dashboard-stat-head">
        <p className="dashboard-stat-label">{stat.label}</p>
        {stat.open ? <Button size="xs" variant="ghost" onClick={stat.open.run}>{stat.open.label}</Button> : null}
      </div>
      <p className="dashboard-stat-value">{stat.value}</p>
      {stat.detail ? <p className="dashboard-stat-detail">{stat.detail}</p> : null}
      {points.length >= 2 ? <Chart className="dashboard-stat-line" mark="sparkline" height={40} label={`${stat.label}: ${stat.value}`} data={chartOfPoints(points, { label: stat.label, value_kind: stat.unit, tone: CHART_TONE[toneOf(points, stat.better)] })} /> : null}
    </div>
  );
}

// A row is the glance shape's row form: lead, title with its when muted beside it, the detail after, the mark, the key
// value and the row's buttons, on one line. With a form the whole row is the form's trigger, so its button only has to
// be seen and pressed.
function Row({ row }: { row: DashboardRow }) {
  const action = row.action;
  const listing: Listing = {
    id: row.id, title: row.title, form: 'row',
    ...(row.detail ? { text: row.detail } : {}), ...(row.meta ? { when: row.meta } : {}), ...(row.badge ? { badge: row.badge } : {}),
    ...(row.icon ? { icon: row.icon } : {}), ...(row.picture ? { picture: row.picture } : {}), ...(row.tone ? { tone: row.tone } : {}),
    ...(row.mark ? { mark: row.mark } : {}), ...(row.value ? { value: row.value, ...(row.unit ? { unit: row.unit } : {}) } : {}),
    ...(row.chips?.length ? { chips: row.chips } : {}), ...(row.whole ? { whole: true } : {}),
    ...(action ? { actions: [{ id: 'act', label: action.label }] } : {}),
  };
  const run = action && 'run' in action && !row.form ? action.run : undefined;
  const body = (
    <div className="dashboard-row" data-asks={row.form ? 'true' : undefined}>
      <ListingCard listing={listing} onAction={() => run?.()} onOpen={row.open && !row.form ? () => row.open?.() : undefined} controls={row.queue ? <QueueJobButton {...row.queue} /> : null}
        className="flex-1 rounded-lg border-0 bg-transparent px-0 shadow-none" />
    </div>
  );
  return <li className="dashboard-row-item">{row.form ? <HoverFormCell form={row.form}>{body}</HoverFormCell> : body}</li>;
}

function ChartBody({ card }: { card: Extract<DashboardCard, { kind: 'chart' }> }) {
  if (!card.points.length) return <CardEmpty card={card} />;
  return (
    <div className="dashboard-chart" data-tone={toneOf(card.points, card.better)}>
      <Chart
        mark="area"
        height={220}
        label={card.title}
        value={card.value}
        detail={card.detail}
        follow
        data={chartOfPoints(card.points, { label: card.title, value_kind: card.unit, tone: CHART_TONE[toneOf(card.points, card.better)] })}
      />
    </div>
  );
}

function RowsBody({ card }: { card: Extract<DashboardCard, { kind: 'rows' }> }) {
  if (!card.rows.length) return <CardEmpty card={card} />;
  return <ul className="dashboard-rows">{card.rows.map(row => <Row key={row.id} row={row} />)}</ul>;
}

function FeedBody({ card }: { card: Extract<DashboardCard, { kind: 'feed' }> }) {
  if (!card.items.length) return <CardEmpty card={card} />;
  return (
    <ol className="dashboard-feed">
      {card.items.map(item => (
        <li key={item.id} className="dashboard-feed-item" data-tone={item.tone}>
          <PersonTag name={item.who} picture={item.picture ?? null} size="sm" />
          <div className="dashboard-feed-text">
            <p className="dashboard-feed-title"><span className="dashboard-feed-who">{item.who}</span> {item.title}</p>
            {item.detail ? <p className="dashboard-feed-detail">{item.detail}</p> : null}
          </div>
          <time className="dashboard-feed-when" dateTime={item.at}>{relativeWhen(item.at)}</time>
        </li>
      ))}
    </ol>
  );
}

function Tile({ tile }: { tile: DashboardTile }) {
  const body = (
    <article
      className="dashboard-tile"
      role={tile.open ? 'link' : undefined}
      tabIndex={tile.open ? 0 : undefined}
      aria-label={tile.open ? tile.title : undefined}
      onClick={tile.open}
      onKeyDown={tile.open ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tile.open?.(); } } : undefined}
    >
      <div className="dashboard-tile-picture">{tile.preview}</div>
      <div className="dashboard-tile-heading">
        {tile.badge ? <Badge className="dashboard-tile-badge" variant="default" size="sm">{tile.badge.label}</Badge> : null}
        <p className="dashboard-tile-title" title={tile.title}>{tile.title}</p>
      </div>
      <div className="dashboard-tile-meta">
        <PersonTag name={tile.who} picture={tile.whoPicture ?? null} size="sm" />
        <span className="dashboard-tile-who">{tile.who}</span>
        <time className="dashboard-tile-when" dateTime={tile.at}>{relativeWhen(tile.at)}</time>
      </div>
    </article>
  );
  const hover = tile.hover;
  return <li className="dashboard-tile-item">{hover ? <HoverPreview trigger={body} items={[hover]} preview={item => item} side="bottom" /> : body}</li>;
}

function GalleryBody({ card }: { card: Extract<DashboardCard, { kind: 'gallery' }> }) {
  if (!card.tiles.length) return <CardEmpty card={card} />;
  return <ul className="dashboard-gallery" aria-label={card.title}>{card.tiles.map(tile => <Tile key={tile.id} tile={tile} />)}</ul>;
}

function SpotlightBody({ card }: { card: Extract<DashboardCard, { kind: 'spotlight' }> }) {
  const stages = card.stages ?? [];
  return (
    <div className="dashboard-spotlight">
      <p className="dashboard-spotlight-headline">{card.headline}</p>
      {stages.length ? (
        <ol className="dashboard-spotlight-thread">
          {stages.map(stage => (
            <li key={stage.label} className="dashboard-spotlight-stage" data-tone={stage.tone}>
              <p className="dashboard-spotlight-stage-label">{stage.label}</p>
              <p className="dashboard-spotlight-stage-text">{stage.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {card.detail ? <p className="dashboard-spotlight-detail">{card.detail}</p> : null}
      {card.action || card.queue ? (
        <div className="dashboard-spotlight-actions">
          {card.queue ? <QueueJobButton {...card.queue} size="default" /> : null}
          {card.action ? <Button onClick={card.action.run}>{card.action.label}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

// What a card with nothing in it says: the caller's words, and its way out when it gives one.
function CardEmpty({ card }: { card: DashboardCard }) {
  if (!card.emptyDetail && !card.emptyAction && !card.emptyIcon) return <p className="dashboard-empty">{card.empty}</p>;
  return (
    <div className="dashboard-card-empty">
      <EmptyState
        icon={card.emptyIcon ? <NamedIcon name={card.emptyIcon} aria-hidden="true" /> : undefined}
        title={card.empty}
        description={card.emptyDetail}
        action={card.emptyAction?.label}
        onAction={card.emptyAction?.run}
      />
    </div>
  );
}

// How each kind of card draws its body (invariant 4).
const CARD_DRAWERS: Record<DashboardCard['kind'], (card: never) => React.ReactNode> = {
  chart: card => <ChartBody card={card} />,
  rows: card => <RowsBody card={card} />,
  feed: card => <FeedBody card={card} />,
  gallery: card => <GalleryBody card={card} />,
  spotlight: card => <SpotlightBody card={card} />,
};

// The head's form button: pressing or hovering it opens the shared hover form (invariant 7).
function CardFormButton({ form }: { form: DashboardCardForm }) {
  return <HoverFormCell form={form.form}><Button size="sm" variant="outline" render={<span />}>{form.label}</Button></HoverFormCell>;
}

function Card({ card }: { card: DashboardCard }) {
  return (
    <section className="dashboard-card" data-kind={card.kind} data-wide={card.wide === 'full' ? 'full' : card.wide ? 'true' : undefined} data-dashboard-card={card.id}>
      <header className="dashboard-card-head">
        <div>
          <h2 className="dashboard-card-title">{card.title}<AutomationMarks automations={card.automations} /></h2>
          {card.description ? <p className="dashboard-card-description">{card.description}</p> : null}
        </div>
        {card.form || card.more ? (
          <div className="dashboard-card-head-actions">
            {card.form ? <CardFormButton form={card.form} /> : null}
            {card.more ? <Button size="sm" variant="ghost" onClick={card.more.run}>{card.more.label}</Button> : null}
          </div>
        ) : null}
      </header>
      {CARD_DRAWERS[card.kind](card as never)}
    </section>
  );
}

/** The greeting, the line under it, the caller's action and the one next step: the head of a dashboard. */
export function DashboardHead({ greeting, summary, glance, headerAction, next }: Pick<DashboardProps, 'greeting' | 'summary' | 'glance' | 'headerAction' | 'next'>) {
  const nextBody = next ? (
    <div className="dashboard-next" data-asks={next.form ? 'true' : undefined}>
      <div className="dashboard-row-text">
        <p className="dashboard-next-title">{next.title}</p>
        {next.detail ? <p className="dashboard-row-detail">{next.detail}</p> : null}
      </div>
      {next.action ? <Button size="sm" onClick={next.form ? undefined : next.action.run}>{next.action.label}</Button> : null}
    </div>
  ) : null;
  return (
    <React.Fragment>
      <header className="dashboard-head">
        <h1 className="dashboard-greeting">{greeting}</h1>
        {glance?.length ? (
          <div className="dashboard-glance" role="group" aria-label={greeting}>
            {glance.map(item => {
              const body = <><span className="dashboard-glance-value" data-tone={item.tone}>{item.value}</span><span className="dashboard-glance-label">{item.label}</span></>;
              return item.open
                ? <Button key={item.id} variant="ghost" className="dashboard-glance-tile" onClick={item.open.run} aria-label={`${item.value} ${item.label}`}>{body}</Button>
                : <div key={item.id} className="dashboard-glance-tile">{body}</div>;
            })}
          </div>
        ) : summary ? <p className="dashboard-summary">{summary}</p> : null}
      </header>
      {headerAction}
      {nextBody ? (next?.form ? <HoverFormCell form={next.form}>{nextBody}</HoverFormCell> : nextBody) : null}
    </React.Fragment>
  );
}

/** The row of stat cards, each with its line over time. */
export function DashboardStats({ stats }: { stats: DashboardStat[] }) {
  return stats.length ? <div className="dashboard-stats">{stats.map(stat => <StatCard key={stat.id} stat={stat} />)}</div> : null;
}

/** One card drawn on its own, as one piece of a board of placed screens. */
export const DashboardCardView = Card;

/** One part of a dashboard drawn alone (its head, its numbers or one card), with the dashboard's own tokens and the
 *  width it measures itself by, so it reads the same as inside the whole dashboard. */
export function DashboardPiece({ children }: { children: React.ReactNode }) {
  return <div className="dashboard-piece">{children}</div>;
}

export function Dashboard({ greeting, summary, glance, headerAction, next, stats, cards }: DashboardProps) {
  return (
    <div className="dashboard">
      <DashboardHead greeting={greeting} summary={summary} glance={glance} headerAction={headerAction} next={next} />
      <DashboardStats stats={stats} />
      <div className="dashboard-grid">{cards.map(card => <Card key={card.id} card={card} />)}</div>
    </div>
  );
}
