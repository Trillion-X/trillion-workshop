//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The publish-composer screen: a calm, composer-first surface for writing a post
// and sending it to a place to post. The visual contract follows the Mobbin
// composer anatomy — the writing surface is the largest region; the destinations
// + readiness column is second; result/status is third. On a wide viewport the
// composer sits left and the destinations/status rail sits right; on a narrow
// viewport they stack. One code path renders both (ResponsiveSwitch is pure CSS),
// so the same component renders identically on web DOM and the iOS JSCore host —
// there is no `PublishComposerMobile`, no `window.*`, no platform branch.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Composed ENTIRELY from shared `ui` primitives. Zero `className`, zero raw
//    DOM, zero in-package CSS (L065/L066). A missing capability is elevated to
//    the shared `ui` package (e.g. Textarea `borderless`), never duplicated here.
// 2. The composer is BLIND to how a place to post works. It renders owner-
//    translated destination fragments (label/detail/statusLine/canPublish/
//    disabledReason) and emits intent by id. It never names, branches on, or
//    displays a destination's internal execution/transport vocabulary (L090/L098).
// 3. Readiness tone is derived from the binary capability `canPublish` (Physics),
//    never from enumerating owner status keys. Human readiness text comes from the
//    owner-provided `statusLine`. The only status vocabulary this screen owns is
//    its OWN attempt lifecycle (posting / posted / failed) — declared as data.
// 4. Every render state is reachable from data + attempt state alone: loading
//    (rows === null), empty (no destinations), sparse/dense (the list), posting,
//    posted (result), failed (sanitized error + retry).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Feather, Inbox, Loader2, Send } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  Icon,
  Input,
  OutputFieldList,
  ResponsiveSwitch,
  SafeErrorCard,
  StatusDot,
  Text,
  Textarea,
  statusView,
  type OutputField,
  type StatusOverrides,
  type StatusTone,
} from '@/packages/ui';
import {
  type PublishComposerSurfaceView,
  type PublishDestinationOption,
} from '@/packages/publish-composer/read-data/read-publish-composer';
import { submitPublication } from '@/packages/publish-composer/do-work/submit-publication';

// ---------------------------------------------------------------------------
// ATTEMPT LIFECYCLE
// ---------------------------------------------------------------------------
// The composer owns its own attempt vocabulary (it IS the owner of "did my post
// go out?"), so declaring these labels/tones here is not owner-vocabulary
// leakage — it is this screen describing its own state as data. `failed` is not
// listed because a failure renders the dedicated SafeErrorCard, not a pill.

type AttemptPhase = 'idle' | 'posting' | 'queued' | 'failed';

const ATTEMPT_VOCAB: StatusOverrides = {
  posting: { label: 'Posting…', tone: 'info' },
  queued: { label: 'Posted', tone: 'success', isTerminal: true },
};

const EMPTY_SURFACE: PublishComposerSurfaceView = {
  destinations: [],
  selectedDestinationId: '',
  blockers: [],
};

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------
// PURE SURFACE: this component takes its resolved view as a prop and owns no
// data fetching. `surface === null` is the loading state (data not resolved);
// any value (even EMPTY_SURFACE) means the surface has loaded. The live data
// edge (`useBitfieldData`) lives in the mount wrapper, mirroring the CRM and
// calendar surfaces — so the full render-state matrix is drivable from fixtures
// (one code path, identical on web DOM and the iOS JSCore host).

interface PublishComposerProps {
  /** Resolved owner-translated surface view. `null` = loading (not yet resolved). */
  surface: PublishComposerSurfaceView | null;
}

/** Map a status tone to a StatusDot status (neutral has no dot color → idle). */
function toneToDot(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'accent' | 'idle' {
  return tone === 'neutral' ? 'idle' : tone;
}

/** Derive a fallback title from the first non-empty line of the body. */
function titleFromBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 120) ?? 'Untitled publication';
}

export function PublishComposer({ surface: surfaceProp }: PublishComposerProps) {
  // `surfaceProp === null` = the data has not resolved yet (loading). Any value
  // (even EMPTY_SURFACE) means the surface has loaded — empty destinations is a
  // genuine "no place to post yet" state, visually distinct from loading. The
  // data hook throws on error, so error rendering is owned by the host error
  // boundary in the mount wrapper, not a flag here.
  const isLoading = surfaceProp === null;
  const surface = surfaceProp ?? EMPTY_SURFACE;

  const [title, setTitle] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [phase, setPhase] = useState<AttemptPhase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<{ fields: OutputField[] } | null>(null);

  // Seed the selection from the owner's suggested default once destinations
  // arrive. Keyed on the resolved id so it does not fight a user's later choice.
  useEffect(() => {
    if (!destinationId && surface.selectedDestinationId) {
      setDestinationId(surface.selectedDestinationId);
    }
  }, [destinationId, surface.selectedDestinationId]);

  const selected = surface.destinations.find((destination) => destination.id === destinationId);
  const canPublish = bodyText.trim().length > 0
    && !!selected
    && selected.canPublish
    && phase !== 'posting';

  async function handlePublish() {
    if (!canPublish || !selected) return;
    const effectiveTitle = title.trim() || titleFromBody(bodyText);
    setPhase('posting');
    setErrorText(null);
    setResult(null);
    try {
      await submitPublication({
        destinationId: selected.id,
        actionId: selected.actionId,
        title: effectiveTitle,
        bodyText,
        metadata: { description: effectiveTitle, visibility: 'default' },
      });
      setResult({
        fields: [
          { key: 'place', label: 'Posted to', value: selected.label, priority: 1 },
          { key: 'title', label: 'Title', value: effectiveTitle, priority: 2 },
        ],
      });
      setBodyText('');
      setTitle('');
      setPhase('queued');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[publish-composer] publish failed:', raw);
      setErrorText(raw);
      setPhase('failed');
    }
  }

  function handleRetry() {
    setPhase('idle');
    setErrorText(null);
  }

  // -------------------------------------------------------------------------
  // LOADING — calm, before any structure is known.
  // -------------------------------------------------------------------------
  if (isLoading) {
    return (
      <Container layout="vertical" height="full" padding="xl" alignItems="center" justifyContent="center">
        <EmptyPlaceholder icon={Loader2} message="Loading places to post…" />
      </Container>
    );
  }

  // -------------------------------------------------------------------------
  // COMPOSER — the writing surface (largest region in every layout).
  // -------------------------------------------------------------------------
  const composer = (
    <Card variant="surface" padding="lg" layout="stack" flex={1} height="full">
      <Input
        borderless
        aria-label="Publication title"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        placeholder="Title, optional"
      />
      <Textarea
        borderless
        aria-label="Publication body"
        value={bodyText}
        onChange={(event) => setBodyText(event.currentTarget.value)}
        placeholder="Write it here. When it is out of your head, press Post."
        rows={16}
      />
    </Card>
  );

  // -------------------------------------------------------------------------
  // DESTINATIONS — places to post + readiness (second region).
  // -------------------------------------------------------------------------
  const destinations = (
    <Container layout="vertical" gap="sm">
      <Text variant="heading-xs" color="secondary">Post to</Text>
      {surface.destinations.length === 0 ? (
        <EmptyPlaceholder
          icon={Inbox}
          message={surface.blockers[0] ?? 'No place to post yet. Connect one to start posting.'}
        />
      ) : (
        <Container layout="vertical" gap="sm" overflow="y-auto" maxHeight="46vh">
          {surface.destinations.map((destination) => destinationRow(
            destination,
            destination.id === destinationId,
            () => setDestinationId(destination.id),
          ))}
        </Container>
      )}
    </Container>
  );

  // -------------------------------------------------------------------------
  // ACTION + ATTEMPT STATUS — one strong primary action; disabled carries a
  // human reason; in-flight/terminal attempt state shows as a quiet pill.
  // -------------------------------------------------------------------------
  const attempt = phase === 'posting' || phase === 'queued'
    ? statusView(phase, ATTEMPT_VOCAB)
    : null;

  const actionBar = (
    <Container layout="vertical" gap="sm">
      {attempt ? (
        <Container layout="horizontal" gap="sm" alignItems="center">
          <StatusDot status={toneToDot(attempt.tone)} pulse={phase === 'posting'} label={attempt.label} />
          <Text variant="caption" color="secondary">{attempt.label}</Text>
        </Container>
      ) : null}
      {selected && !selected.canPublish ? (
        <Text variant="caption" color="warning">
          {selected.disabledReason ?? 'This place cannot post yet.'}
        </Text>
      ) : null}
      <Button variant="primary" disabled={!canPublish} onClick={handlePublish}>
        <Icon icon={Send} size="sm" />
        {phase === 'posting' ? 'Posting…' : 'Post'}
      </Button>
    </Container>
  );

  // -------------------------------------------------------------------------
  // OUTCOME — result on success, sanitized error + retry on failure (third
  // region). Internal-looking fields are denied by OutputFieldList itself.
  // -------------------------------------------------------------------------
  const outcome = (
    <Container layout="vertical" gap="md">
      {phase === 'failed' ? (
        <SafeErrorCard
          message={errorText ?? undefined}
          title="Did not post"
          retryLabel="Try again"
          onRetry={handleRetry}
        />
      ) : null}
      {phase === 'queued' && result ? (
        <Card variant="nested" padding="md" layout="stack">
          <Container layout="horizontal" gap="sm" alignItems="center">
            <StatusDot status="success" label="Posted" />
            <Text variant="heading">Posted</Text>
          </Container>
          <OutputFieldList fields={result.fields} />
        </Card>
      ) : null}
    </Container>
  );

  // -------------------------------------------------------------------------
  // HEADER — quiet identity row.
  // -------------------------------------------------------------------------
  const header = (
    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
      <Container layout="horizontal" alignItems="center" gap="sm">
        <Badge variant="neutral">
          <Icon icon={Feather} size="sm" />
          Write a post
        </Badge>
        <Text variant="caption" color="faint">Write it, then post it.</Text>
      </Container>
    </Container>
  );

  // -------------------------------------------------------------------------
  // LAYOUT — composer-first everywhere. Wide: composer left, rail right.
  // Narrow: composer, then destinations, action, outcome stacked. The same
  // element instances render in both subtrees (one is CSS-hidden) — one code
  // path, identical on web and iOS.
  // -------------------------------------------------------------------------
  return (
    <Container layout="vertical" gap="lg" padding="xl" height="full">
      {header}
      <ResponsiveSwitch
        wide={(
          <Container layout="horizontal" gap="lg" flex="1" alignItems="stretch">
            <Container layout="vertical" gap="md" flex="1">
              {composer}
            </Container>
            <Container layout="vertical" gap="lg" minWidth="320px" maxWidth="sm">
              {destinations}
              {actionBar}
              {outcome}
            </Container>
          </Container>
        )}
        narrow={(
          <Container layout="vertical" gap="lg">
            {composer}
            {destinations}
            {actionBar}
            {outcome}
          </Container>
        )}
      />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// DESTINATION ROW
// ---------------------------------------------------------------------------
// A selectable place-to-post row. Readiness is shown two ways for scannability:
// a StatusDot (capability colour) and a Badge carrying the owner's human
// statusLine. Tone is derived from `canPublish` only — the row never inspects
// or names the destination's internal status vocabulary.

function destinationRow(
  destination: PublishDestinationOption,
  isSelected: boolean,
  onSelect: () => void,
): React.ReactElement {
  const readyText = destination.statusLine || (destination.canPublish ? 'Ready' : 'Not ready');
  return (
    <Card
      key={destination.id}
      variant={isSelected ? 'solid' : 'nested'}
      padding="sm"
      layout="row"
      interactive
      selected={isSelected}
      onClick={onSelect}
      role="button"
      aria-pressed={isSelected}
      aria-label={destination.label}
    >
      <Container layout="horizontal" gap="sm" alignItems="center">
        <StatusDot status={destination.canPublish ? 'success' : 'warning'} label={readyText} />
        <Container layout="vertical" gap="xs" flex="1">
          <Text variant="heading" truncate>{destination.label}</Text>
          {destination.detail ? (
            <Text variant="caption" color="faint" truncate>{destination.detail}</Text>
          ) : null}
          {!destination.canPublish && destination.disabledReason ? (
            <Text variant="caption" color="warning">{destination.disabledReason}</Text>
          ) : null}
        </Container>
        <Badge variant={destination.canPublish ? 'success' : 'warning'}>{readyText}</Badge>
      </Container>
    </Card>
  );
}
