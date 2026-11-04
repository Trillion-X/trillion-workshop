// packages/screen-arrangement/show/mount-worker-console.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The "worker console" placeable surface: an EmbeddedScreenArrangement whose
// tabs are built at mount time from DATA (`surfaceInput.tabs`), each tab mounting
// a package surface SCOPED to one subject (`surfaceInput.subject`, merged into
// every tab's surfaceInput by `buildWorkerConsoleLayout`).
//
// A board node (or anything) opens this by mounting
// `{ packageName: 'screen-arrangement', entryName: 'worker-console' }` with
// surfaceInput `{ tabs: [...], subject: { agentId, ... } }`. The board hands the
// DATA tab list + the clicked subject's identity; this mount renders the tabbed
// container. Blind: it names no agent, no product, no console concept — it is a
// generic "render THESE tabs, scoped to THIS subject" host.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The tab list is DATA (surfaceInput.tabs) — never hardcoded here.
// 2. The console is TRANSIENT: `acceptPersistedState={() => false}` makes the
//    freshly-built per-subject `initialState` ALWAYS win, so a persisted layout
//    from a PREVIOUS subject can never leak its baked-in surfaceInput into this
//    subject's tabs. (Persistence exists only so live tab moves are not lost
//    mid-session; on remount the fresh subject state is authoritative.)
// 3. Fail-open: malformed/empty tabs render an empty container, never a crash.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { EmbeddedScreenArrangement } from './EmbeddedScreenArrangement';
import {
  buildWorkerConsoleLayout,
  type WorkerConsoleTabSpec,
} from '../read-data/worker-console-arrangement';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

const WORKER_CONSOLE_LAYOUT_STATE_INPUT = 'embedded-workspace-layout-state';
const WORKER_CONSOLE_LAYOUT_STATE_ADDRESS_LABEL = 'autonomous-worker-console-layout-state';
// A transient console never adopts a persisted layout — the fresh per-subject
// initialState is the SSOT (invariant 2). Rejecting on load is what guarantees
// subject A's tabs never render with subject B's baked surfaceInput.
const REJECT_PERSISTED_STATE = () => false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read + validate the DATA tab list from surfaceInput (drop malformed rows). */
function readTabs(input: Record<string, unknown>): WorkerConsoleTabSpec[] {
  const raw = input.tabs;
  if (!Array.isArray(raw)) return [];
  const tabs: WorkerConsoleTabSpec[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const { id, title, packageName, entryName, icon, surfaceInput } = row as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string') continue;
    if (typeof packageName !== 'string' || typeof entryName !== 'string') continue;
    tabs.push({
      id,
      title,
      packageName,
      entryName,
      ...(typeof icon === 'string' ? { icon } : {}),
      ...(isRecord(surfaceInput) ? { surfaceInput } : {}),
    });
  }
  return tabs;
}

/** Read the shared subject scoping object (merged into every tab's surfaceInput). */
function readSubject(input: Record<string, unknown>): Record<string, unknown> {
  const raw = input.subject;
  return isRecord(raw) ? raw : {};
}

function WorkerConsoleMaterial({ props }: { props: Record<string, unknown> }) {
  const input = (isRecord(props.surfaceInput)
    ? props.surfaceInput
    : isRecord(props.surface_input)
      ? props.surface_input
      : {}) as Record<string, unknown>;
  const initialState = React.useMemo(() => {
    const tabs = readTabs(input);
    const subject = readSubject(input);
    return buildWorkerConsoleLayout(tabs, subject);
  }, [input]);

  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="worker-console material">
        <EmbeddedScreenArrangement
          initialState={initialState}
          layoutEntryInput={WORKER_CONSOLE_LAYOUT_STATE_INPUT}
          persistence={{ valueAddressLabel: WORKER_CONSOLE_LAYOUT_STATE_ADDRESS_LABEL }}
          acceptPersistedState={REJECT_PERSISTED_STATE}
          chrome={{ 'header.actions.newTab': false }}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <WorkerConsoleMaterial props={props} />);
}
