// packages/notifications/show/notification-setting-screen.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The web envelope: the stateful container that turns descriptor DATA + live
// engine state into an interaction. It is the ONLY place that holds runtime
// state (the user's pending choice, the write phase, connectivity) and the ONLY
// place that talks to the data layer (useBitfieldData) and the write authority
// (saveSetting). It then hands a fully-resolved, blind HumanSettingView to the
// pure renderer.
//
// This container is itself GENERIC — it names no notification mode. It works for
// ANY single-select setting descriptor; the notification-specific part lives
// entirely in things-to-store-and-run.json. (L069: the container + projection +
// renderer together are the single generative primitive; each setting is a
// configuration of it.)
//
// Data flow:
//   props.records (descriptor + policy graph) ─┐
//   useBitfieldData(value selector) ───────────┼─▶ readNotificationsPolicy()
//   local selectedOptionId ────────────────────┘        │ SettingPolicyView
//                                                        ▼            │ actionRoute
//   phase + offline ────────────────────────▶ projectSettingView()   │
//                                                        │ HumanSettingView
//                                                        ▼            ▼
//                                              <BlindSettingRenderer/> │
//   onSelect/onSave/onRevert ──▶ state + saveSetting(policy.actionRoute)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary. Descriptor, action route, and value selector are all
//    read from data; no mode key, target, or action name is written in source.
//    The write route is the canonical `policy.actionRoute` resolved by the policy
//    reader — this envelope never reads a second route from the descriptor.
// 2. The engine is the authority for the saved value: after a successful write
//    the container clears its pending selection and lets the live value (via
//    useBitfieldData) drive the current option. It never optimistically rewrites
//    the saved state itself.
// 3. The pure renderer/projection never see DOM or connectivity — this envelope
//    detects offline (navigator) and passes it down as data.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { mountReactSurface } from '../../ui';
import {
  readNotificationsPolicy,
  type PublishedRecordRow,
} from '../read-data/read-notifications-policy';
import {
  projectSettingView,
  type WritePhase,
} from '../read-data/project-setting-view';
import {
  buildCurrentValueSelector,
  currentRecordsFromEntry,
  type SettingValueSelector,
} from '../read-data/setting-live-source';
import { saveSetting } from '../do-work/save-setting';
import { BlindSettingRenderer } from './blind-setting-renderer';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the package's published records and the chosen descriptor from mount
 * props. The runtime hands the package's own published records (the `things`
 * from things-to-store-and-run.json) to the surface; the descriptor is the first
 * setting-control among them, or an explicitly supplied one.
 */
function readSurfaceInput(props: Record<string, unknown>): {
  records: PublishedRecordRow[];
  descriptor: unknown;
} {
  const surface = isRecord(props.surfaceInput) ? { ...props, ...props.surfaceInput } : props;
  const rawRecords = Array.isArray(surface.records) ? surface.records : [];
  const records: PublishedRecordRow[] = rawRecords
    .filter(isRecord)
    .map((row) => ({ address: typeof row.address === 'string' ? row.address : undefined, payload: row.payload }));
  const descriptor = isRecord(surface.descriptor)
    ? surface.descriptor
    : records.find((row) => isRecord(row.payload) && row.payload.kind === 'setting-control')?.payload ?? null;
  return { records, descriptor };
}

/**
 * Web connectivity, as data. Lives only in the web envelope; the renderer and
 * projection stay blind to navigator.
 */
function useOffline(): boolean {
  const get = () =>
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? !navigator.onLine : false;
  const [offline, setOffline] = React.useState<boolean>(get);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setOffline(get());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return offline;
}

interface StatefulProps {
  descriptor: unknown;
  records: PublishedRecordRow[];
  currentRecords: unknown[];
}

/**
 * The shared stateful core. Receives the already-resolved live `currentRecords`
 * so the data-hook call site can vary (live selector vs default-only) without
 * duplicating any interaction logic. The write route is not threaded as a prop:
 * it is `policy.actionRoute`, resolved inside the same memoized policy below
 * (SSOT — one route, one reader).
 */
function SettingScreenStateful({ descriptor, records, currentRecords }: StatefulProps) {
  const [selectedOptionId, setSelectedOptionId] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<WritePhase>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const offline = useOffline();

  const policy = React.useMemo(
    () => readNotificationsPolicy({ descriptor, records, currentRecords, selectedOptionId }),
    [descriptor, records, currentRecords, selectedOptionId],
  );

  const view = React.useMemo(
    () => projectSettingView({ policy, phase, offline, errorMessage }),
    [policy, phase, offline, errorMessage],
  );

  const onSelect = React.useCallback((optionId: string) => {
    setSelectedOptionId(optionId);
    // Leaving a terminal phase the moment the user acts again.
    setPhase((current) => (current === 'saved' || current === 'error' ? 'idle' : current));
    setErrorMessage(null);
  }, []);

  const onRevert = React.useCallback(() => {
    setSelectedOptionId(null);
    setPhase('idle');
    setErrorMessage(null);
  }, []);

  const onSave = React.useCallback(async () => {
    const optionId = policy.selectedOptionId;
    if (!optionId || !policy.save.enabled || offline) return;
    setPhase('saving');
    setErrorMessage(null);
    const result = await saveSetting(policy.actionRoute, optionId);
    if (result.ok) {
      // Engine is authority: clear the pending choice and let the live value
      // drive the current option; surface the transient confirmation.
      setSelectedOptionId(null);
      setPhase('saved');
    } else {
      setPhase('error');
      setErrorMessage(result.error ?? null);
    }
  }, [policy.selectedOptionId, policy.save.enabled, policy.actionRoute, offline]);

  return <BlindSettingRenderer view={view} onSelect={onSelect} onSave={onSave} onRevert={onRevert} />;
}

/** Live path: subscribes to the descriptor's value feed and feeds rows down. */
function SettingScreenLive({
  selector,
  ...rest
}: Omit<StatefulProps, 'currentRecords'> & { selector: SettingValueSelector }) {
  const entry = useBitfieldData(selector);
  const currentRecords = React.useMemo(() => currentRecordsFromEntry(entry), [entry]);
  return <SettingScreenStateful {...rest} currentRecords={currentRecords} />;
}

export interface NotificationSettingScreenProps {
  props: Record<string, unknown>;
}

export function NotificationSettingScreen({ props }: NotificationSettingScreenProps) {
  const { records, descriptor } = React.useMemo(() => readSurfaceInput(props), [props]);
  const selector = React.useMemo(() => buildCurrentValueSelector(descriptor), [descriptor]);

  if (selector) {
    return (
      <SettingScreenLive descriptor={descriptor} records={records} selector={selector} />
    );
  }
  return (
    <SettingScreenStateful descriptor={descriptor} records={records} currentRecords={[]} />
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, React.createElement(NotificationSettingScreen, { props }));
}
