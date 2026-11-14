// package-set://bitfield-studio/packages/travel-operations/show/TravelOperationsPanel.tsx

import React, { startTransition, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  Clock3,
  Hotel,
  Luggage,
  Map,
  Plus,
  Route,
  StickyNote,
} from 'lucide-react';
import { Badge, Button, Card, Container, Icon, Input, ScrollableSurface, Text, Textarea, cn } from '@/packages/ui';
import {
  appendTravelNotesState,
  buildTripCreateAction,
  buildTripNote,
  type TravelNotesState,
  type TravelOperationsModel,
  type TripAction,
  type TripCreateAction,
  type TripCreateLane,
  type TripItem,
  type TripLane,
} from '@/packages/travel-operations/read-data/travel-operations';
import {
  dispatchTripCreateAction,
  dispatchTravelItemAction,
  writeTravelNoteState,
} from '@/packages/travel-operations/do-work/travel-operation-requests';

export const TRIP_BOARD_SURFACE_CSS = `
.trip-board {
  --trip-board-accent: var(--accent-primary);
  --trip-board-rail: color-mix(in srgb, var(--bg-primary) 86%, var(--accent-primary) 14%);
  --trip-board-panel: color-mix(in srgb, var(--bg-surface) 82%, var(--accent-primary) 18%);
  --trip-board-panel-soft: color-mix(in srgb, var(--bg-surface) 70%, transparent);
  --trip-board-line: color-mix(in srgb, var(--border-primary) 72%, var(--text-primary) 8%);
  position: relative;
  isolation: isolate;
  min-height: 100%;
  margin: -4px;
  padding: clamp(10px, 1.6vw, 18px);
  overflow: hidden;
  border: 1px solid var(--trip-board-line);
  border-radius: clamp(28px, 4vw, 42px);
  background: color-mix(in srgb, var(--bg-surface) 88%, var(--bg-primary) 12%);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-primary) 14%, transparent), 0 24px 70px rgba(0, 0, 0, 0.24);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.trip-board-shell {
  position: relative;
  display: grid;
  gap: clamp(12px, 1.8vw, 20px);
}

.trip-board-card,
.trip-board-hero,
.trip-board-focus-card,
.trip-board-create-card,
.trip-board-lane-card,
.trip-board-empty-card,
.trip-board-note-card,
.trip-board-later-card {
  border-color: var(--trip-board-line) !important;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-primary) 10%, transparent), 0 16px 40px rgba(0, 0, 0, 0.18) !important;
}

.trip-board-hero {
  min-height: clamp(180px, 24vw, 300px);
  border-radius: clamp(28px, 4vw, 46px) !important;
  background: color-mix(in srgb, var(--glass-bg-primary) 90%, var(--bg-primary) 10%) !important;
}

.trip-board-orb {
  display: grid;
  width: clamp(54px, 7vw, 78px);
  height: clamp(54px, 7vw, 78px);
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent);
  border-radius: 26px;
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-primary) 12%, transparent), 0 14px 32px rgba(0, 0, 0, 0.16);
}

.trip-board-kicker {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 34%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  color: var(--text-secondary);
  padding: 6px 10px;
  font-size: var(--font-size-caption);
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.trip-board-title {
  font-size: clamp(42px, 6vw, 78px);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 0.96;
}

.trip-board-subtitle {
  max-width: 40rem;
  color: var(--text-secondary);
  font-size: clamp(17px, 2vw, 24px);
  line-height: 1.3;
}

.trip-board-create-card {
  border-radius: 32px !important;
  background: color-mix(in srgb, var(--glass-bg-primary) 92%, var(--bg-primary) 8%) !important;
}

.trip-board-create-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 0.72fr);
  gap: clamp(14px, 2vw, 22px);
  align-items: end;
}

.trip-board-create-fields {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: 12px;
}

.trip-board-create-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.trip-board-create-button {
  min-height: 82px !important;
  align-items: stretch !important;
  justify-content: space-between !important;
  flex-direction: column !important;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent) !important;
  border-radius: 22px !important;
  background: color-mix(in srgb, var(--bg-surface) 78%, transparent) !important;
  color: var(--text-primary) !important;
  padding: 13px 14px !important;
  text-align: left !important;
  transform: translateY(0);
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
}

.trip-board-create-button:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 48%, transparent) !important;
  background: color-mix(in srgb, var(--bg-surface) 86%, var(--accent-primary) 6%) !important;
  transform: translateY(-1px);
}

.trip-board-create-button:active {
  transform: translateY(0) scale(0.99);
}

.trip-board-create-button-main {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 950;
}

.trip-board-create-button-hint {
  color: var(--text-muted);
  font-size: var(--font-size-caption);
  font-weight: 750;
  line-height: 1.2;
}

.trip-board-focus-card {
  border-radius: clamp(30px, 4vw, 48px) !important;
  background: color-mix(in srgb, var(--glass-bg-primary) 92%, var(--bg-primary) 8%) !important;
}

.trip-board-focus-title {
  max-width: 900px;
  font-size: clamp(42px, 6.5vw, 82px);
  font-weight: 800;
  letter-spacing: -0.045em;
  line-height: 0.98;
  text-wrap: balance;
}

.trip-board-focus-reason {
  max-width: 48rem;
  color: var(--text-secondary);
  font-size: clamp(19px, 2.2vw, 28px);
  line-height: 1.25;
}

.trip-board-detail-card {
  border-radius: 24px !important;
  background: color-mix(in srgb, var(--bg-primary) 38%, transparent) !important;
}

.trip-board-lane-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(10px, 1.5vw, 16px);
}

.trip-board-lane-card {
  min-height: 168px;
  overflow: hidden;
  border-radius: 30px !important;
  background: color-mix(in srgb, var(--bg-surface) 74%, transparent) !important;
}

.trip-board-lane-card--packing {
  border-color: color-mix(in srgb, var(--status-warning, var(--accent-primary)) 28%, var(--border-primary) 72%) !important;
}

.trip-board-lane-card--bookings {
  border-color: color-mix(in srgb, var(--status-success, var(--accent-primary)) 28%, var(--border-primary) 72%) !important;
}

.trip-board-lane-icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 26%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-primary) 34%, transparent);
}

.trip-board-lane-count {
  font-size: clamp(54px, 7vw, 92px);
  font-weight: 800;
  letter-spacing: -0.045em;
  line-height: 0.9;
}

.trip-board-note-card,
.trip-board-later-card,
.trip-board-empty-card {
  border-radius: 30px !important;
  background: color-mix(in srgb, var(--bg-surface) 70%, transparent) !important;
}

.trip-board input,
.trip-board textarea {
  min-height: 52px;
  border-radius: 18px !important;
  font-size: 16px;
  font-weight: 780;
}

.trip-board textarea {
  min-height: 124px;
}

.trip-board-later-row {
  border: 1px solid color-mix(in srgb, var(--border-primary) 62%, transparent) !important;
  border-radius: 18px !important;
  background: color-mix(in srgb, var(--bg-primary) 32%, transparent) !important;
}

@media (max-width: 980px) {
  .trip-board-create-grid,
  .trip-board-create-fields,
  .trip-board-lane-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .trip-board {
    margin: -10px;
    border-radius: 26px;
    padding: 10px;
  }

  .trip-board-create-actions {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .trip-board-create-button {
    transition: none;
  }

  .trip-board-create-button:hover,
  .trip-board-create-button:active {
    transform: none;
  }
}
`;

function TripBoardStyles() {
  return <style>{TRIP_BOARD_SURFACE_CSS}</style>;
}

function latestNoteText(model: TravelOperationsModel): string {
  const text = model.evidence[0]?.payload?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : 'No notes yet.';
}

function laneIcon(lane: TripLane['id']) {
  if (lane === 'itinerary') return Route;
  if (lane === 'packing') return Luggage;
  return Hotel;
}

function LaneCard({ lane }: { lane: TripLane }) {
  return (
    <Card
      variant="nested"
      padding="lg"
      className={cn('trip-board-lane-card', `trip-board-lane-card--${lane.id}`)}
    >
      <Container layout="vertical" gap="md" className="h-full">
        <Container layout="horizontal" alignItems="center" gap="md">
          <span className="trip-board-lane-icon" aria-hidden="true">
            <Icon icon={laneIcon(lane.id)} size="lg" color="muted" />
          </span>
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="heading-lg">{lane.label}</Text>
          <span className="trip-board-lane-count">{lane.count}</span>
        </Container>
      </Container>
    </Card>
  );
}

function TripLanes({ lanes }: { lanes: readonly TripLane[] }) {
  return (
    <div className="trip-board-lane-grid" data-testid="travel-lanes">
      {lanes.map((lane) => <LaneCard key={lane.id} lane={lane} />)}
    </div>
  );
}

interface FocusCardProps {
  item: TripItem;
  onDispatch: (item: TripItem, action: TripAction) => void | Promise<unknown>;
}

function FocusCard({ item, onDispatch }: FocusCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <Card
      variant={item.priority === 'critical' ? 'error' : 'solid'}
      padding="lg"
      data-testid="travel-focus-card"
      className="trip-board-focus-card relative overflow-hidden"
    >
      <Container layout="vertical" gap="lg" className="relative">
        <Container layout="vertical" gap="md" className="max-w-4xl">
          <div className="trip-board-focus-title">{item.title}</div>
          <div className="trip-board-focus-reason">{item.reason}</div>
        </Container>

        <Container layout="horizontal" gap="sm" wrap>
          {item.action ? (
            <Button variant="accent" size="lg" onClick={() => onDispatch(item, item.action!)} data-testid="travel-primary-action">
              {item.action.label}
            </Button>
          ) : (
            <Button variant="secondary" size="lg" disabled>Done for now</Button>
          )}
          {item.detail.length > 0 && (
            <Button variant="ghost" size="lg" onClick={() => setDetailOpen((open) => !open)}>
              {detailOpen ? 'Hide details' : 'Details'}
            </Button>
          )}
        </Container>

        {detailOpen && item.detail.length > 0 && (
          <Card variant="nested" padding="md" data-testid="travel-detail-sidecar" className="trip-board-detail-card">
            <Container layout="vertical" gap="sm">
              <Text variant="heading-xs">Details</Text>
              <Container layout="horizontal" gap="xs" wrap>
                {item.detail.map((detail) => (
                  <Badge key={detail} variant="muted-outline" size="sm">{detail}</Badge>
                ))}
              </Container>
            </Container>
          </Card>
        )}
      </Container>
    </Card>
  );
}

function EmptyTripState() {
  return (
    <Card
      variant="solid"
      padding="lg"
      data-testid="travel-empty-state"
      className="trip-board-empty-card relative overflow-hidden"
    >
      <Container layout="horizontal" justifyContent="between" alignItems="end" gap="lg" wrap>
        <Container layout="vertical" gap="sm" className="max-w-3xl">
          <Badge variant="warning" size="sm">Nothing planned yet</Badge>
          <Text variant="display" leading="tight" className="text-balance">
            Build the trip.
          </Text>
          <Text variant="body" color="secondary">Start with one piece.</Text>
        </Container>
      </Container>
    </Card>
  );
}

const createButtons: Array<{ lane: TripCreateLane; label: string; hint: string; icon: typeof CalendarDays }> = [
  { lane: 'itinerary', label: 'Add itinerary', hint: 'Plan a move', icon: CalendarDays },
  { lane: 'packing', label: 'Add packing', hint: 'Pack a thing', icon: Luggage },
  { lane: 'bookings', label: 'Add booking', hint: 'Save a booking', icon: Hotel },
];

interface CreateCardProps {
  model: TravelOperationsModel;
  onCreate: (action: TripCreateAction) => void | Promise<unknown>;
}

function CreateCard({ model, onCreate }: CreateCardProps) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [pendingLane, setPendingLane] = useState<TripCreateLane | null>(null);
  const [message, setMessage] = useState('');

  async function submitCreate(lane: TripCreateLane) {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setMessage('Type the trip thing first.');
      return;
    }
    setPendingLane(lane);
    setMessage('');
    try {
      const action = buildTripCreateAction({ model, lane, title: cleanTitle, detail });
      await onCreate(action);
      startTransition(() => {
        setTitle('');
        setDetail('');
        setMessage('Added.');
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[travel-operations] add failed:', raw);
      setMessage('Add failed.');
    } finally {
      setPendingLane(null);
    }
  }

  return (
    <Card
      variant="solid"
      padding="lg"
      layout="stack"
      aria-label="Add to trip"
      className="trip-board-create-card"
    >
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" justifyContent="between" alignItems="start" gap="md" wrap>
          <Container layout="horizontal" gap="md" alignItems="center" className="max-w-2xl">
            <span className="trip-board-orb" aria-hidden="true">
              <Icon icon={Plus} size="xl" color="muted" />
            </span>
            <Container layout="vertical" gap="xs">
              <Text variant="heading-xl">Add to trip</Text>
              <Text variant="body" color="secondary">Type one thing. Pick the list.</Text>
            </Container>
          </Container>
          {message && <Badge variant={message === 'Added.' ? 'success' : 'warning'} size="sm">{message}</Badge>}
        </Container>

        <div className="trip-board-create-grid">
          <div className="trip-board-create-fields">
            <Input
              label="Thing"
              placeholder="Airport ride, blue jacket, hotel booking"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            <Input
              label="When or category"
              placeholder="Friday 2pm, Documents, Hotel"
              value={detail}
              onChange={(event) => setDetail(event.currentTarget.value)}
            />
          </div>

          <div className="trip-board-create-actions">
            {createButtons.map((button) => (
              <Button
                key={button.lane}
                variant="secondary"
                size="lg"
                type="button"
                disabled={pendingLane !== null}
                onClick={() => void submitCreate(button.lane)}
                className="trip-board-create-button"
              >
                <span className="trip-board-create-button-main">
                  <Icon icon={button.icon} size="md" color="muted" />
                  {pendingLane === button.lane ? 'Adding' : button.label}
                </span>
                <span className="trip-board-create-button-hint">{button.hint}</span>
              </Button>
            ))}
          </div>
        </div>
      </Container>
    </Card>
  );
}

interface CaptureCardProps {
  model: TravelOperationsModel;
  onSaveNote: (state: TravelNotesState) => Promise<unknown> | unknown;
}

function CaptureCard({ model, onSaveNote }: CaptureCardProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function submitNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanText = text.trim();
    if (!cleanText) {
      setMessage('Add a note first.');
      return;
    }
    const capturedAt = new Date().toISOString();
    const note = buildTripNote({
      id: `note:travel-operations:${capturedAt}`,
      sourceKind: 'manual-text',
      sourceRef: `manual-capture:${capturedAt}`,
      capturedAt,
      capturedBy: 'traveler:owner',
      text: cleanText,
    });
    setPending(true);
    setMessage('');
    try {
      await onSaveNote(appendTravelNotesState(model, { evidence: [note] }));
      startTransition(() => {
        setText('');
        setNoteOpen(false);
        setMessage('Note saved.');
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[travel-operations] note save failed:', raw);
      setMessage('Note save failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card variant="nested" padding="lg" layout="stack" aria-label="Trip note" className="trip-board-note-card">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" wrap>
        <Container layout="horizontal" gap="md" alignItems="center" className="max-w-2xl">
          <span className="trip-board-lane-icon" aria-hidden="true">
            <Icon icon={StickyNote} size="lg" color="muted" />
          </span>
          <Container layout="vertical" gap="xs" className="min-w-0">
            <Text variant="heading-lg">Trip note</Text>
            <Text variant="caption" color="muted" clamp={1}>{message || latestNoteText(model)}</Text>
          </Container>
        </Container>
        <Container layout="horizontal" alignItems="center" gap="sm" wrap>
          <Button variant="secondary" size="lg" type="button" onClick={() => setNoteOpen((open) => !open)}>
            {noteOpen ? 'Hide note' : 'Add note'}
          </Button>
        </Container>
      </Container>
      {noteOpen && (
        <form onSubmit={submitNote}>
          <Container layout="vertical" gap="md">
              <Textarea
                label="Trip note"
                rows={4}
                placeholder="Paste any trip note."
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
              />
            <Container layout="horizontal" alignItems="center" justifyContent="end" gap="md" wrap>
              <Button variant="secondary" size="lg" type="submit" disabled={pending}>
                {pending ? 'Saving note' : 'Save note'}
              </Button>
            </Container>
          </Container>
        </form>
      )}
    </Card>
  );
}

export interface TravelOperationsPanelProps {
  model: TravelOperationsModel;
  onDispatch?: (item: TripItem, action: TripAction) => void | Promise<unknown>;
  onCreate?: (action: TripCreateAction) => void | Promise<unknown>;
  onSaveNote?: (state: TravelNotesState) => Promise<unknown> | unknown;
}

export function TravelOperationsPanel({
  model,
  onDispatch = dispatchTravelItemAction,
  onCreate = dispatchTripCreateAction,
  onSaveNote = writeTravelNoteState,
}: TravelOperationsPanelProps) {
  const [laterOpen, setLaterOpen] = useState(false);
  const focus = model.focus;

  return (
    <ScrollableSurface>
      <TripBoardStyles />
      <Container layout="vertical" gap="lg" data-testid="travel-operations-surface" className="trip-board">
        <div className="trip-board-shell">
          <Card
            variant="ghost"
            padding="lg"
            className="trip-board-hero relative overflow-hidden"
          >
            <Container layout="horizontal" justifyContent="between" alignItems="start" gap="lg" wrap>
              <Container layout="vertical" gap="md" className="max-w-5xl">
                <span className="trip-board-kicker">
                  <Icon icon={Map} size="sm" color="muted" />
                  Trip Board
                </span>
                <div className="trip-board-title">
                  {focus ? 'Next move.' : 'Build the trip.'}
                </div>
                <div className="trip-board-subtitle">
                  Plan / pack / book.
                </div>
              </Container>
            </Container>
          </Card>

          <CreateCard model={model} onCreate={onCreate} />

          {focus ? (
            <FocusCard item={focus} onDispatch={onDispatch} />
          ) : (
            <EmptyTripState />
          )}

          <TripLanes lanes={model.lanes} />

          <Container layout="grid" gridCols="auto-fill-sm" gap="lg">
            <CaptureCard model={model} onSaveNote={onSaveNote} />
            {model.later.length > 0 && (
              <Card variant="nested" padding="lg" layout="stack" className="trip-board-later-card">
                <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
                  <Container layout="horizontal" alignItems="center" gap="sm">
                    <span className="trip-board-lane-icon" aria-hidden="true">
                      <Icon icon={Clock3} size="lg" color="muted" />
                    </span>
                    <Text variant="heading-lg">Later</Text>
                  </Container>
                  <Button variant="ghost" size="sm" onClick={() => setLaterOpen((open) => !open)}>
                    {laterOpen ? 'Hide later' : 'Show later'}
                    <Icon icon={ChevronDown} size="sm" color="muted" className={laterOpen ? 'rotate-180' : ''} />
                  </Button>
                </Container>
                {laterOpen && (
                  <Container layout="vertical" gap="sm" data-testid="travel-later-list">
                    {model.later.map((item) => (
                      <Card key={item.id} variant="ghost" padding="sm" className="trip-board-later-row">
                        <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
                          <Container layout="vertical" gap="xs" className="min-w-0">
                          <Text variant="heading" weight="semibold" clamp={1}>{item.title}</Text>
                          <Text variant="caption" color="muted" clamp={1}>{item.reason}</Text>
                        </Container>
                      </Container>
                    </Card>
                    ))}
                  </Container>
                )}
              </Card>
            )}
          </Container>
        </div>
      </Container>
    </ScrollableSurface>
  );
}
