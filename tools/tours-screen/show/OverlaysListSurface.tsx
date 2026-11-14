// packages/guided-overlay/show/OverlaysListSurface.tsx
//
// The guided-overlays LIST surface: a blind, DATA-driven catalog of every authored
// `walkthrough-definition` in this app, showing which are completed vs available and
// letting the user START (or replay) any one. It owns no tour content and no engine:
// it reads the package's own kind-scoped `walkthrough-feed` and composes the SAME
// read fold (`foldWalkthroughRecords`/`foldWalkthroughProgress`) and the SAME start
// channel (`emitWalkthroughEvent`) that the always-on `WalkthroughHost` uses. A Start
// button dispatches the definition's own trigger event; the mounted host picks it up
// and runs the tour. Adding a walkthrough = one DATA row; this surface needs no edit.
// Anatomy grounded on award-winning getting-started checklists (Peloton/Deel/Revolut,
// reference-adaptation-contract REF-GUIDED-OVERLAYS-LIST-SURFACE): per-row icon +
// title + status + action.
import * as React from 'react';
import { Button, Container, NamedIcon, ScrollableSurface, Text } from '../../ui/index.ts';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  foldWalkthroughRecords,
  foldWalkthroughProgress,
  type WalkthroughRecord,
} from '../read-data/walkthrough-eeaf.ts';
import { startEventForWalkthrough } from '../engine/trigger-intake.ts';
import { emitWalkthroughEvent } from './WalkthroughHost.tsx';

/** Normalize `useBitfieldData` rows into fold records (mirror of the host's own). */
function toRecords(raw: unknown): WalkthroughRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((row) => {
      const hasWrapper = 'payload' in row && !!row.payload && typeof row.payload === 'object';
      return {
        address: typeof row.address === 'string' ? row.address : '',
        value_json: hasWrapper ? (row.payload as Record<string, unknown>) : row,
      };
    });
}

export function OverlaysListSurface(): React.ReactElement {
  const raw = useBitfieldData('walkthrough-feed');
  const records = React.useMemo(() => toRecords(raw), [raw]);
  const defs = React.useMemo(() => foldWalkthroughRecords(records), [records]);
  const progress = React.useMemo(() => foldWalkthroughProgress(records), [records]);
  const list = React.useMemo(() => Object.values(defs), [defs]);

  return (
    <ScrollableSurface>
    <Container layout="vertical" gap="lg" width="full" maxWidth="lg" alignItems="stretch">
      <Container layout="vertical" gap="xs">
        <Text as="h1" size="2xl" weight="bold">Guided walkthroughs</Text>
        <Text tone="muted" size="md">
          Interactive tours for this app. Start any one for a guided walk through the surface.
        </Text>
      </Container>

      {list.length === 0 ? (
        <Container layout="vertical" gap="sm" padding="xl" alignItems="center">
          <NamedIcon name="Compass" />
          <Text tone="muted">No walkthroughs available yet.</Text>
        </Container>
      ) : (
        <Container layout="vertical" gap="md" width="full">
          {list.map((def) => {
            const trigger = def.triggers?.[0];
            const onceKey = trigger?.once_key;
            const completed = onceKey ? progress.consumedOnceKeys.has(onceKey) : false;
            const startEvent = startEventForWalkthrough(def.triggers ?? [], def.id);
            return (
              <Container
                key={def.id}
                layout="horizontal"
                gap="md"
                padding="lg"
                rounded="lg"
                background="secondary"
                alignItems="center"
                justifyContent="between"
                width="full"
              >
                <Container layout="horizontal" gap="md" alignItems="center">
                  <NamedIcon name="Sparkles" />
                  <Container layout="vertical" gap="xs">
                    <Text weight="semibold" size="md">{def.title ?? def.id}</Text>
                    <Text tone="muted" size="sm">
                      {completed ? 'Completed' : 'Available'}
                      {def.steps?.length
                        ? ` · ${def.steps.length} ${def.steps.length === 1 ? 'step' : 'steps'}`
                        : ''}
                    </Text>
                  </Container>
                </Container>
                <Button
                  variant={completed ? 'ghost' : 'primary'}
                  size="md"
                  disabled={!startEvent}
                  onClick={() => {
                    if (startEvent) emitWalkthroughEvent(startEvent);
                  }}
                >
                  {completed ? 'Replay' : 'Start'}
                </Button>
              </Container>
            );
          })}
        </Container>
      )}
    </Container>
    </ScrollableSurface>
  );
}
