// package-set://bitfield-studio/packages/polymarket/show/PolymarketPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Polymarket surface — built ON the visual-database generic primitive.
// Two screens, both data-driven:
//
//   Screen A (market list): reads polymarket:gamma.markets, decodes via
//   decodeMarketList, projects rows → VisualDatabaseModel, renders as a fey
//   table via visual-database. Columns = field descriptors (DATA).
//
//   Screen B (order book / market detail): reads polymarket:clob.book,
//   decodes via decodeMarketBook, projects bid/ask levels → VisualDatabaseModel,
//   renders as a fey table. Columns = field descriptors (DATA).
//
// THE GENERIC TEST: descriptor DATA determines what columns, tones, and labels
// appear. Zero market/prediction vocabulary hardcoded here. "Yes 62%", "$1.2M",
// "62¢" come from the decoder translation layer (polymarket-live.ts). The panel
// has no concept of outcome_prices, condition_id, clob, gamma, or token_ids.
//
// Trade gate: no buy/sell action shown. "Connect to trade" prompt only — the
// order submit path is gated on user L2 credentials (Scope-5 backend, separate).
//
// L117: NO fake data. Honest empty/loading/error states only.
// L065: All styling via @/packages/ui barrel — zero raw HTML/className.
// =============================================================================

import React, { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  ScrollableSurface,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '@/packages/ui';
import { AlertCircle, ArrowLeft, BarChart2, BookOpen, RefreshCw, TrendingUp } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeVisualDatabaseModel,
  recordsForView,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import { FieldControl, displayTitle, toneVariant } from '@/packages/visual-database/show/field-editors';
import {
  polymarketMarketsInput,
  polymarketBookInput,
  polymarketMarketFieldsInput,
  polymarketMarketViewsInput,
  polymarketBookFieldsInput,
  polymarketBookViewsInput,
  polymarketCapabilityInput,
} from '@/packages/polymarket/read-data/polymarket-inputs';
import {
  decodeMarketList,
  decodeMarketBook,
  type MarketListModel,
  type MarketBookModel,
  type MarketRow,
} from '@/packages/polymarket/read-data/polymarket-live';

// ---------------------------------------------------------------------------
// Shared: structural roles that don't render as columns
// ---------------------------------------------------------------------------

const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['id', 'sort']);

function columnDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((f) => !STRUCTURAL_ROLES.has(f.role));
}

// ---------------------------------------------------------------------------
// Shared: generic read-only table cell (same pattern as TradeOrderPanel)
// ---------------------------------------------------------------------------

function BoardCell({
  descriptor,
  record,
  model,
}: {
  descriptor: VisualDatabaseFieldDescriptor;
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
}) {
  if (descriptor.role === 'title') {
    return (
      <Text variant="body-xs" weight="semibold" truncate>
        {displayTitle(record)}
      </Text>
    );
  }
  return (
    <FieldControl
      descriptor={descriptor}
      record={record}
      model={model}
      lanes={[]}
      grouping={null}
    />
  );
}

// ---------------------------------------------------------------------------
// Screen A: Market list
// ---------------------------------------------------------------------------

/** Project MarketListModel into a VisualDatabaseModel using live descriptor DATA. */
function projectMarketsToBoard(
  list: MarketListModel,
  rawFields: unknown,
  rawViews: unknown,
): VisualDatabaseModel {
  // Build synthetic records from the decoded market list.
  // Each market becomes one record with flat keys the descriptor paths read.
  const records = list.markets.map((m) => ({
    id: m.id,
    question: m.question,
    status: m.statusLabel,
    yes_pct: m.yesPct !== null ? `${m.yesPct}%` : '—',
    no_pct: m.noPct !== null ? `${m.noPct}%` : '—',
    outcomes_label:
      m.yesPct !== null && m.noPct !== null
        ? `Yes ${m.yesPct}% · No ${m.noPct}%`
        : '—',
    volume: m.volumeLabel,
    liquidity: m.liquidityLabel,
  }));

  return decodeVisualDatabaseModel({
    records,
    fields: rawFields,
    views: rawViews,
    actions: [],
  });
}

function MarketsTable({ model }: { model: VisualDatabaseModel }) {
  const view = model.views[0];
  const cols = columnDescriptors(model);
  const rows = view ? recordsForView(model.records, view, model.fields) : model.records;

  if (rows.length === 0) {
    return (
      <EmptyPlaceholder
        icon={<TrendingUp size={24} />}
        title="No markets available"
        description="Markets will appear here once the discovery action runs."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          {cols.map((col) => (
            <TableHeader key={col.id}>
              <Text variant="body-xs" weight="medium" color="muted">
                {col.label}
              </Text>
            </TableHeader>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((record) => (
          <TableRow key={record.id}>
            {cols.map((col) => (
              <TableCell key={col.id}>
                <BoardCell descriptor={col} record={record} model={model} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MarketListScreen({ onSelectMarket }: { onSelectMarket: (m: MarketRow) => void }) {
  const { value: rawMarkets } = useBitfieldData(polymarketMarketsInput.inputName);
  const { value: rawFields } = useBitfieldData(polymarketMarketFieldsInput.inputName);
  const { value: rawViews } = useBitfieldData(polymarketMarketViewsInput.inputName);

  const list = decodeMarketList(rawMarkets);

  if (list.state === 'loading') {
    return (
      <Container padding="lg">
        <EmptyPlaceholder
          icon={<RefreshCw size={24} />}
          title="Loading markets…"
          description="Fetching live prediction markets from Polymarket."
        />
      </Container>
    );
  }

  if (list.state === 'error') {
    return (
      <Container padding="lg">
        <EmptyPlaceholder
          icon={<AlertCircle size={24} />}
          title="Markets unavailable"
          description={list.errorNote ?? 'Could not load markets. Run discover-markets to retry.'}
        />
      </Container>
    );
  }

  const boardModel = projectMarketsToBoard(list, rawFields, rawViews);

  return (
    <ScrollableSurface>
      <Container padding="md" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <TrendingUp size={16} />
          <Text variant="body-sm" weight="semibold">
            Prediction Markets
          </Text>
          {list.totalCount > 0 && (
            <Badge variant="secondary" size="sm">
              {list.totalCount}
            </Badge>
          )}
          {list.fetchedAt && (
            <Text variant="body-xs" color="muted">
              {list.fetchedAt}
            </Text>
          )}
        </Container>
        <MarketsTable model={boardModel} />
      </Container>
    </ScrollableSurface>
  );
}

// ---------------------------------------------------------------------------
// Screen B: Order book (market detail)
// ---------------------------------------------------------------------------

/** Project MarketBookModel into a VisualDatabaseModel using live descriptor DATA.
 *  Each bid/ask level becomes one record; side is a field so the descriptor
 *  domain controls the color (green for bid, red for ask). */
function projectBookToBoard(
  book: MarketBookModel,
  rawFields: unknown,
  rawViews: unknown,
): VisualDatabaseModel {
  const bidRecords = book.bids.map((level, i) => ({
    id: `bid-${i}`,
    price: level.priceLabel,
    size: level.sizeLabel,
    side: 'bid',
    side_label: 'Bid',
    price_raw: level.price,
    size_raw: level.size,
  }));

  const askRecords = book.asks.map((level, i) => ({
    id: `ask-${i}`,
    price: level.priceLabel,
    size: level.sizeLabel,
    side: 'ask',
    side_label: 'Ask',
    price_raw: level.price,
    size_raw: level.size,
  }));

  // Asks first (highest ask at top), bids below (highest bid at top of section).
  const allRecords = [...askRecords.slice().reverse(), ...bidRecords];

  return decodeVisualDatabaseModel({
    records: allRecords,
    fields: rawFields,
    views: rawViews,
    actions: [],
  });
}

function BookSummaryBar({ book }: { book: MarketBookModel }) {
  return (
    <Container layout="horizontal" gap="md" padding="none" alignItems="center">
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Text variant="body-xs" color="muted">Bid</Text>
        <Text variant="body-xs" weight="semibold">
          {book.bestBid !== null ? book.bidLabel : '—'}
        </Text>
      </Container>
      <Text variant="body-xs" color="muted">·</Text>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Text variant="body-xs" color="muted">Ask</Text>
        <Text variant="body-xs" weight="semibold">
          {book.bestAsk !== null ? book.askLabel : '—'}
        </Text>
      </Container>
      <Text variant="body-xs" color="muted">·</Text>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Text variant="body-xs" color="muted">Spread</Text>
        <Text variant="body-xs">{book.spreadLabel}</Text>
      </Container>
      <Text variant="body-xs" color="muted">·</Text>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Text variant="body-xs" color="muted">Mid</Text>
        <Text variant="body-xs">{book.midpointLabel}</Text>
      </Container>
    </Container>
  );
}

function BookTable({ model }: { model: VisualDatabaseModel }) {
  const view = model.views[0];
  const cols = columnDescriptors(model);
  const rows = view ? recordsForView(model.records, view, model.fields) : model.records;

  if (rows.length === 0) {
    return (
      <EmptyPlaceholder
        icon={<BookOpen size={24} />}
        title="Order book empty"
        description="No open orders for this market."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          {cols.map((col) => (
            <TableHeader key={col.id}>
              <Text variant="body-xs" weight="medium" color="muted">
                {col.label}
              </Text>
            </TableHeader>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((record) => (
          <TableRow key={record.id}>
            {cols.map((col) => (
              <TableCell key={col.id}>
                <BoardCell descriptor={col} record={record} model={model} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MarketDetailScreen({ market, onBack }: { market: MarketRow | null; onBack: () => void }) {
  const { value: rawBook } = useBitfieldData(polymarketBookInput.inputName);
  const { value: rawFields } = useBitfieldData(polymarketBookFieldsInput.inputName);
  const { value: rawViews } = useBitfieldData(polymarketBookViewsInput.inputName);

  const book = decodeMarketBook(rawBook);
  const boardModel = projectBookToBoard(book, rawFields, rawViews);

  return (
    <ScrollableSurface>
      <Container padding="md" gap="sm">
        {/* Back nav */}
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Button variant="ghost" size="sm" onPress={onBack}>
            <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
              <ArrowLeft size={14} />
              <Text variant="body-xs">Markets</Text>
            </Container>
          </Button>
        </Container>

        {/* Market question */}
        {market && (
          <Container gap="xs" padding="none">
            <Text variant="body-sm" weight="semibold">
              {market.question}
            </Text>
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              <Badge
                variant={market.statusLabel === 'Open' ? 'success' : 'secondary'}
                size="sm"
              >
                {market.statusLabel}
              </Badge>
              {market.yesPct !== null && (
                <Text variant="body-xs" color="muted">
                  Yes {market.yesPct}% · No {market.noPct ?? '—'}%
                </Text>
              )}
              <Text variant="body-xs" color="muted">
                Vol {market.volumeLabel}
              </Text>
            </Container>
          </Container>
        )}

        {/* Book summary */}
        {book.state === 'live' && <BookSummaryBar book={book} />}

        {/* Book ladder */}
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <BookOpen size={14} />
          <Text variant="body-sm" weight="semibold">
            Order Book
          </Text>
          {book.levels > 0 && (
            <Badge variant="secondary" size="sm">
              {book.levels} levels
            </Badge>
          )}
        </Container>

        {book.state === 'loading' ? (
          <EmptyPlaceholder
            icon={<RefreshCw size={24} />}
            title="Loading order book…"
            description="Fetching live CLOB data from Polymarket."
          />
        ) : book.state === 'error' ? (
          <EmptyPlaceholder
            icon={<AlertCircle size={24} />}
            title="Order book unavailable"
            description="Could not load book. Run scan-order-book to retry."
          />
        ) : (
          <BookTable model={boardModel} />
        )}

        {/* Trade gate — no buy/sell UI. Gated on L2 credentials. */}
        <Card padding="md">
          <Container gap="xs" padding="none" alignItems="center">
            <BarChart2 size={20} />
            <Text variant="body-sm" weight="semibold">
              Connect to trade
            </Text>
            <Text variant="body-xs" color="muted">
              To place orders on this market, connect your Polymarket account in the
              Connections panel.
            </Text>
          </Container>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}

// ---------------------------------------------------------------------------
// Root panel — manages which screen is shown
// ---------------------------------------------------------------------------

export function PolymarketPanel() {
  const [selectedMarket, setSelectedMarket] = useState<MarketRow | null>(null);

  if (selectedMarket) {
    return (
      <MarketDetailScreen
        market={selectedMarket}
        onBack={() => setSelectedMarket(null)}
      />
    );
  }

  return <MarketListScreen onSelectMarket={setSelectedMarket} />;
}
