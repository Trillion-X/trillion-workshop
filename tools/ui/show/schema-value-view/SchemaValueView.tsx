// parts/ui/show/schema-value-view/SchemaValueView.tsx
//
// PURPOSE
//   Shows what a step, a tool or an AI handed back as a designed view, not a field dump. The value's SHAPE picks the
//   view (result-views.json, evaluated by result-view.ts): a status becomes a status card with a sentence ("Live,
//   checks loaded, version from 3:08 PM"), one record a summary card, a list of records a list of items, a table or a
//   timeline, a set of numbers metric tiles, a failure an error card, nothing an empty state. Ids, hashes and raw
//   timestamps are not shown; there is no raw-data toggle. Any screen that shows a result uses this instead of
//   printing JSON.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the view knows no workflow, tool or field; the shape-to-view rows, the field roles and the words are
//      DATA in result-views.json. This file only draws a view the data picked.
//   2. Every element is a shared ui component (Card, Container, Text, Table, StatStrip, Timeline, StatusDot,
//      SafeErrorCard, EmptyPlaceholder); inline style is spacing and grid layout only. Labels are sentence-case
//      captions, with no small line above a heading, no left accent bar and no coloured fill on a press.
//   3. `designed={false}` is for a place that compares or edits data and must show every field (two versions of a
//      document side by side): the same plain field list as before, with no machine-field filter. It never adds a toggle.
//   4. Reference anatomy: 21st.dev and Preline status cards, key-value lists, timelines and KPI groups (named per view
//      in result-views.json), Cofounder's answered-questions panel for the field list.

import React, { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Card } from '../card';
import { Button } from '../button';
import { cn } from '../cn';
import { Container } from '../container';
import { EmptyPlaceholder } from '../empty-placeholder';
import { SafeErrorCard } from '../safe-error-card';
import { StatStrip } from '../stat-strip';
import { StatusDot } from '../status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table';
import { Text } from '../text';
import { Timeline } from '../timeline';
import rules from './result-views.json';
import { resultView, type Fact, type Item, type ResultView, type StateView, type Tone } from './result-view';
import { valuePieces, type JsonSchema, type ValuePiece } from './value-shape';

export type { JsonSchema, ValuePiece } from './value-shape';
export type { ResultView } from './result-view';

export interface SchemaValueViewProps {
  /** The value to show, exactly as it was handed back. */
  readonly value: unknown;
  /** The JSON Schema describing it, when there is one; without it field names become the labels. */
  readonly schema?: JsonSchema;
  /** false: every field, as a plain field list, for a place that compares data (default: the designed view). */
  readonly designed?: boolean;
  /** The moment the view reads "now" at; for tests and proof pictures only. */
  readonly now?: number;
}

const DOT: Record<Tone, 'success' | 'error' | 'info' | 'idle'> = { good: 'success', bad: 'error', working: 'info', neutral: 'idle' };
// Label/value rows: the wrapper is a size container, so the layout follows the width of the pane the view sits in (a
// phone, or a narrow desktop pane), not the window. Narrow: label above value, value full width. From 28rem up: two
// columns for short values. A long value (a sentence, or several lines) always takes the full width under its label.
const FACT_BOX = '@container/facts min-w-0';
const FACT_GRID = 'grid grid-cols-1 gap-y-1.5 @[28rem]/facts:grid-cols-[minmax(5.5rem,9rem)_minmax(0,1fr)] @[28rem]/facts:gap-x-3';
const FACT_LONG_AT = 48;
const isLongFact = (value: string): boolean => value.length > FACT_LONG_AT || value.includes('\n');
const TILE_ROW = rules.limits.tiles_per_row;

function Label({ text }: { text: string | null }) {
  return text ? <Text variant="caption">{text}</Text> : null;
}

function State({ state }: { state: StateView }) {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <StatusDot status={DOT[state.tone]} size="sm" label={state.word} />
      <Text variant="caption" color="secondary">{state.word}</Text>
    </Container>
  );
}

function Facts({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <div className={FACT_BOX} data-result-facts="">
      <div className={FACT_GRID}>
        {facts.map((fact, index) => {
          const long = !fact.href && isLongFact(fact.value);
          const full = long ? '@[28rem]/facts:col-span-full' : undefined;
          return (
            <React.Fragment key={index}>
              <Text variant="caption" className={cn('min-w-0', full)}>{fact.label}</Text>
              {fact.href
                ? <Text as="a" variant="body-xs" href={fact.href} target="_blank" rel="noreferrer" className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{fact.value}</Text>
                : <Text variant="body-xs" wrap="preserve" className={cn('min-w-0', full)} style={{ overflowWrap: 'anywhere' }}>{fact.value}</Text>}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function Children({ views }: { views: ResultView[] }) {
  return views.length ? <Container layout="vertical" gap="md">{views.map((child, index) => <ViewOf key={index} view={child} />)}</Container> : null;
}

function ItemCard({ item }: { item: Item }) {
  return (
    <Card variant="nested" padding="sm">
      <Container layout="vertical" gap="xs">
        {item.title || item.state || item.time ? (
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
            {item.title ? <Text variant="body" weight="semibold">{item.title}</Text> : <span />}
            <Container layout="horizontal" gap="sm" alignItems="center">
              {item.state ? <State state={item.state} /> : null}
              {item.time ? <Text variant="caption">{item.time}</Text> : null}
            </Container>
          </Container>
        ) : null}
        {item.summary ? <Text variant="body-xs" color="secondary" wrap="preserve">{item.summary}</Text> : null}
        {item.chips.length ? <Text variant="caption">{item.chips.join(' · ')}</Text> : null}
        <Facts facts={item.facts} />
        <Children views={item.children} />
      </Container>
    </Card>
  );
}


// Large results stay in this one collection, with every item reachable through shared buttons.
function Items({ items }: { items: Item[] }) {
  const [page, setPage] = useState(0);
  const size = rules.limits.list_items_shown;
  const pages = Math.ceil(items.length / size);
  const current = Math.min(page, Math.max(0, pages - 1));
  const start = current * size;
  const shown = items.slice(start, start + size);
  return (
    <Container layout="vertical" gap="sm" data-result-item-collection="" data-result-items-count={items.length}>
      {pages > 1 ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
          <Text variant="caption" color="secondary" role="status">{rules.words.items_range.replace('{start}', String(start + 1)).replace('{end}', String(Math.min(start + size, items.length))).replace('{total}', String(items.length))}</Text>
          <Container layout="horizontal" gap="xs">
            <Button variant="ghost" size="sm" work={null} disabled={current === 0} onClick={() => setPage(current - 1)}>{rules.words.previous_items}</Button>
            <Button variant="ghost" size="sm" work={null} disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{rules.words.next_items}</Button>
          </Container>
        </Container>
      ) : null}
      <Container layout="vertical" gap="sm">{shown.map((item, index) => <ItemCard key={start + index} item={item} />)}</Container>
    </Container>
  );
}

function ViewOf({ view }: { view: ResultView }): React.ReactElement | null {
  switch (view.view) {
    case 'empty-state':
      return <EmptyPlaceholder icon={Inbox} message={view.message} fill={false} />;
    case 'error-card':
      return <SafeErrorCard title={view.title} message={view.message} />;
    case 'text':
      return (
        <Container layout="vertical" gap="xs">
          <Label text={view.label} />
          <Text variant="body-xs" wrap={view.long ? 'preserve' : undefined}>{view.text}</Text>
        </Container>
      );
    case 'bullets':
      return (
        <Container layout="vertical" gap="xs">
          <Label text={view.label} />
          {view.items.map((entry, index) => <Text key={index} variant="body-xs" wrap="preserve">{entry}</Text>)}
        </Container>
      );
    case 'link-card':
      return (
        <Container layout="vertical" gap="xs">
          <Label text={view.label} />
          <Card variant="nested" padding="sm">
            <Text as="a" variant="body-xs" href={view.href} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{view.text}</Text>
          </Card>
        </Container>
      );
    case 'status-card':
      return (
        <Container layout="vertical" gap="xs">
          <Label text={view.label} />
          <Card variant="nested" padding="md" data-result-view="status-card" data-result-shape={view.shape}>
            <Container layout="vertical" gap="sm">
              <Container layout="horizontal" gap="sm" alignItems="start">
                <span style={{ paddingTop: '6px', display: 'inline-flex' }}><StatusDot status={DOT[view.tone]} size="md" label={view.tone === 'good' ? 'Good' : view.tone === 'bad' ? 'Needs attention' : 'Status'} /></span>
                <Container layout="vertical" gap="xs">
                  <Text variant="body" weight="semibold" wrap="preserve">{view.headline}</Text>
                  {view.sub ? <Text variant="caption">{view.sub}</Text> : null}
                </Container>
              </Container>
              {view.summary ? <Text variant="body-xs" color="secondary" wrap="preserve">{view.summary}</Text> : null}
              <Facts facts={view.facts} />
              <Children views={view.children} />
            </Container>
          </Card>
        </Container>
      );
    case 'summary-card':
      return (
        <Container layout="vertical" gap="xs">
          <Label text={view.label} />
          <Card variant="nested" padding="md" data-result-view="summary-card" data-result-shape={view.shape}>
            <Container layout="vertical" gap="sm">
              {view.title || view.state ? (
                <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                  {view.title ? <Text variant="body" weight="semibold">{view.title}</Text> : <span />}
                  {view.state ? <State state={view.state} /> : null}
                </Container>
              ) : null}
              {view.summary ? <Text variant="body-xs" color="secondary" wrap="preserve">{view.summary}</Text> : null}
              <Facts facts={view.facts} />
              <Children views={view.children} />
            </Container>
          </Card>
        </Container>
      );
    case 'metric-tiles': {
      const rows: { label: string; value: string }[][] = [];
      for (let at = 0; at < view.tiles.length; at += TILE_ROW) rows.push(view.tiles.slice(at, at + TILE_ROW));
      return (
        <Container layout="vertical" gap="xs" data-result-view="metric-tiles">
          <Label text={view.label} />
          {rows.map((row, index) => <StatStrip key={index} stats={row} />)}
        </Container>
      );
    }
    case 'table':
      return (
        <Container layout="vertical" gap="xs" data-result-view="table">
          <Label text={view.label} />
          <Card variant="nested" padding="none" style={{ overflowX: 'auto' }}>
            <Table>
              <TableHeader>
                <TableRow>{view.columns.map(column => <TableHead key={column}>{column}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {view.rows.map((row, index) => (
                  <TableRow key={index}>{row.map((cell, column) => <TableCell key={column}><Text variant="body-xs" wrap="preserve">{cell}</Text></TableCell>)}</TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Container>
      );
    case 'item-list':
      return (
        <Container layout="vertical" gap="xs" data-result-view="item-list">
          <Label text={view.label} />
          <Items items={view.items} />
        </Container>
      );
    case 'timeline':
      return (
        <Container layout="vertical" gap="xs" data-result-view="timeline">
          <Label text={view.label} />
          <Timeline items={view.items.map(item => ({ id: item.id, time: item.time || undefined, title: item.title, detail: item.detail }))} />
        </Container>
      );
    case 'pieces':
      return <Pieces pieces={view.pieces} depth={0} />;
    default:
      return null;
  }
}

// The plain field list: every field in plain words, for a place that compares or edits data (designed={false}), and
// for a value no row of shapes describes.
function Piece({ piece, depth }: { piece: ValuePiece; depth: number }): React.ReactElement {
  if (piece.kind === 'text') {
    return (
      <Container layout="vertical" gap="xs">
        <Label text={piece.label} />
        <Text variant="body-xs" wrap={piece.long ? 'preserve' : undefined}>{piece.text}</Text>
      </Container>
    );
  }
  if (piece.kind === 'list') {
    return (
      <Container layout="vertical" gap="xs">
        <Label text={piece.label} />
        {piece.items.map((item, index) => <Text key={index} variant="body-xs" wrap="preserve">{item}</Text>)}
      </Container>
    );
  }
  if (piece.kind === 'table') {
    return (
      <Container layout="vertical" gap="xs">
        <Label text={piece.label} />
        <Card variant="nested" padding="none" style={{ overflowX: 'auto' }}>
          <Table>
            <TableHeader>
              <TableRow>{piece.columns.map(column => <TableHead key={column}>{column}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {piece.rows.map((row, index) => (
                <TableRow key={index}>{row.map((cell, column) => <TableCell key={column}><Text variant="body-xs" wrap="preserve">{cell}</Text></TableCell>)}</TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Container>
    );
  }
  if (piece.kind === 'cards') {
    return (
      <Container layout="vertical" gap="xs">
        <Label text={piece.label} />
        {piece.cards.map((pieces, index) => (
          <Card key={index} variant="nested" padding="sm">
            <Pieces pieces={pieces} depth={depth + 1} />
          </Card>
        ))}
      </Container>
    );
  }
  return (
    <Container layout="vertical" gap="xs">
      <Label text={piece.label} />
      <Pieces pieces={piece.pieces} depth={depth + 1} />
    </Container>
  );
}

function Pieces({ pieces, depth }: { pieces: ValuePiece[]; depth: number }) {
  return <Container layout="vertical" gap="sm">{pieces.map((piece, index) => <Piece key={index} piece={piece} depth={depth} />)}</Container>;
}

export function SchemaValueView({ value, schema, designed = true, now }: SchemaValueViewProps): React.ReactElement {
  const view = useMemo(() => (designed ? resultView(value, { schema, now }) : null), [value, schema, designed, now]);
  const pieces = useMemo(() => (designed ? [] : valuePieces(value, schema)), [value, schema, designed]);
  return (
    <Container layout="vertical" gap="md" data-schema-value-view="">
      {view ? <ViewOf view={view} /> : <Pieces pieces={pieces} depth={0} />}
    </Container>
  );
}
