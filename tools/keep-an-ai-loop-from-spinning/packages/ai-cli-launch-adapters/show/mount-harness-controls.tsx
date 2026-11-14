// packages/ai-cli-launch-adapters/show/mount-harness-controls.tsx
//
// T8 (Dynamic Stop Control). DATA-driven active-work surface. Mobbin grounding:
// Google Gemini's compact in-composer stop affordance and HoneyBook's explicit
// "End test run" action beside the live run graph.
//
// The surface renders one founder-readable card per live, actionable
// outcome-continuation contract. Controls still come entirely from live
// `harness-control` DATA. Pressing Stop emits a session-stop-requested event
// naming the exact contract; the pause owner writes a harness-stop-pause receipt,
// and every continuation owner consumes that receipt before dispatching again.
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { projectHarnessControls } from '../read-data/read-harness-controls.mjs';

export type HarnessControlDispatch = { target?: string; output_template?: Record<string, unknown> };
export type HarnessControlState = 'loading' | 'active' | 'stopping' | 'stopped' | 'failed' | 'offline' | 'stale' | 'concurrent';

export type HarnessWorkContract = {
  id: string;
  outcome: string;
  nextAction: string | null;
  sessionRef: string | null;
  status: string;
};

export type HarnessControlsProps = {
  controlsSource?: unknown;
  contractsSource?: unknown;
  pausesSource?: unknown;
  onDispatchControl?: (
    dispatch: HarnessControlDispatch | null,
    controlId: string,
    eventId: string,
    contractRef: string,
    sessionRef: string | null,
  ) => void | Promise<void>;
  state?: HarnessControlState;
  errorMessage?: string;
};

function sourceRows(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === 'object' && Array.isArray((source as { records?: unknown[] }).records)) {
    return (source as { records: unknown[] }).records;
  }
  if (source && typeof source === 'object' && Array.isArray((source as { items?: unknown[] }).items)) {
    return (source as { items: unknown[] }).items;
  }
  return [];
}

function payload(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) {
    return value.payload as Record<string, unknown>;
  }
  return value;
}

function readable(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function projectHarnessWork(source: unknown): HarnessWorkContract[] {
  const terminal = new Set(['ACHIEVED', 'KILLED', 'SUPERSEDED']);
  return sourceRows(source)
    .map(payload)
    .filter((row): row is Record<string, unknown> => row?.kind === 'outcome-continuation-contract')
    .map((row) => ({
      id: readable(row.id) ?? readable(row.address) ?? '',
      outcome: readable(row.observable_outcome) ?? 'Complete the active outcome',
      nextAction: readable(row.next_action),
      sessionRef: readable(row.session_ref) ?? readable(row.session_id),
      status: readable(row.status) ?? 'OPEN',
    }))
    .filter((contract) => contract.id && !terminal.has(contract.status.toUpperCase()));
}

export function projectPausedContractIds(source: unknown): Set<string> {
  const ids = new Set<string>();
  sourceRows(source).map(payload).forEach((row) => {
    if (row?.kind !== 'harness-stop-pause' || !Array.isArray(row.paused_contracts)) return;
    row.paused_contracts.forEach((contract) => {
      if (!contract || typeof contract !== 'object') return;
      const id = readable((contract as Record<string, unknown>).id);
      if (id) ids.add(id);
    });
  });
  return ids;
}

function createEventId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `operator-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildHarnessControlRequest(
  dispatch: HarnessControlDispatch | null,
  contractRef: string,
  sessionRef: string | null,
  eventId: string,
) {
  const target = dispatch?.target?.trim();
  if (!target) throw new Error('The control has no owner target.');
  if (!dispatch?.output_template || typeof dispatch.output_template !== 'object') throw new Error('The control has no owner request.');
  if (!contractRef.trim()) throw new Error('The active outcome is unavailable.');
  const sessionId = sessionRef?.trim() || `operator-control-${eventId}`;
  return {
    target,
    payload: {
      ...dispatch.output_template,
      event_id: eventId,
      session_id: sessionId,
      contract_ref: contractRef,
    },
  };
}

export async function dispatchHarnessControl(
  dispatch: HarnessControlDispatch | null,
  contractRef: string,
  sessionRef: string | null,
  eventId: string,
) {
  return sendRequestToBitfieldTarget(buildHarnessControlRequest(dispatch, contractRef, sessionRef, eventId));
}

function isStop(control: string): boolean {
  return control === 'stop';
}

const STATE_COPY: Record<Exclude<HarnessControlState, 'active'>, string> = {
  loading: 'Loading automatic work…',
  stopping: 'Stopping this work…',
  stopped: 'Work stopped. Automatic continuation is paused.',
  failed: 'This work did not stop. Try again.',
  offline: 'Stop is unavailable while the app reconnects.',
  stale: 'Refreshing the current work state…',
  concurrent: 'Another update is finishing. This control will refresh.',
};

const CARD_CLASS = 'glass-surface flex flex-col gap-3 rounded-[var(--radius-default)] border border-[var(--border-primary)] p-4';
const MUTED_TEXT_CLASS = 'text-[length:var(--font-size-body)] text-[var(--text-secondary)]';
const SECONDARY_BUTTON_CLASS = 'inline-flex h-8 items-center justify-center rounded-[var(--radius-control)] bg-[var(--glass-bg-subtle)] px-3 text-[length:var(--font-size-label)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--glass-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40';
const DANGER_BUTTON_CLASS = 'inline-flex h-8 items-center justify-center rounded-[var(--radius-control)] bg-status-error px-3 text-[length:var(--font-size-label)] font-semibold text-black transition-colors hover:bg-status-error/90 disabled:cursor-not-allowed disabled:opacity-40';

function WorkCard({
  contract,
  controls,
  initialState,
  errorMessage,
  onDispatchControl,
}: {
  contract: HarnessWorkContract;
  controls: ReturnType<typeof projectHarnessControls>;
  initialState: HarnessControlState;
  errorMessage?: string;
  onDispatchControl?: HarnessControlsProps['onDispatchControl'];
}) {
  const [state, setState] = React.useState<HarnessControlState>(initialState);
  const [confirmControlId, setConfirmControlId] = React.useState<string | null>(null);
  const eventIds = React.useRef(new Map<string, string>());
  React.useEffect(() => setState(initialState), [initialState]);

  const confirmControl = controls.find((control) => control.id === confirmControlId) ?? null;
  const showButtons = state !== 'stopped';
  const controlsDisabled = ['stopping', 'offline', 'stale', 'concurrent'].includes(state);

  async function dispatchControl(control: (typeof controls)[number]) {
    setConfirmControlId(null);
    setState('stopping');
    const eventId = eventIds.current.get(control.id) ?? createEventId();
    eventIds.current.set(control.id, eventId);
    try {
      if (!onDispatchControl) throw new Error('The stop owner is unavailable.');
      await onDispatchControl(control.dispatch as HarnessControlDispatch | null, control.id, eventId, contract.id, contract.sessionRef);
      eventIds.current.delete(control.id);
      setState('stopped');
    } catch {
      setState('failed');
    }
  }

  return (
    <article className={CARD_CLASS} data-testid="automatic-work-card" data-contract-ref={contract.id} data-state={state}>
      <div className="flex flex-col gap-1">
        <span className="text-[length:var(--font-size-caption)] text-[var(--text-muted)]">Automatic work is running</span>
        <h2 className="text-[length:var(--font-size-heading-sm)] font-semibold text-[var(--text-strong)]">{contract.outcome}</h2>
        {contract.nextAction ? <p className={MUTED_TEXT_CLASS}>Next: {contract.nextAction}</p> : null}
        <p className={MUTED_TEXT_CLASS}>You do not need to do anything.</p>
      </div>

      <div className="flex flex-row flex-wrap items-center gap-2">
        {showButtons ? controls.map((control) => {
          const stop = isStop(control.control);
          return (
            <button
              key={control.id}
              type="button"
              className={stop ? DANGER_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
              disabled={controlsDisabled}
              aria-label={`${control.label}: ${contract.outcome}`}
              aria-busy={stop && state === 'stopping'}
              onClick={() => stop ? setConfirmControlId(control.id) : void dispatchControl(control)}
            >
              {stop && state === 'stopping' ? 'Stopping this work…' : null}
              {state === 'failed' && stop ? 'Try stopping again' : control.label}
            </button>
          );
        }) : null}
        {state !== 'active' ? (
          <span
            className={`${MUTED_TEXT_CLASS}${state === 'failed' ? ' text-status-error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {STATE_COPY[state]}
            {state === 'failed' && errorMessage ? ` ${errorMessage}` : ''}
          </span>
        ) : null}
      </div>

      {confirmControl ? (
        <div className="mt-3">
          {/* A small confirm in place, never a page-blocking dialog. */}
          <div
            role="group"
            aria-labelledby="harness-stop-dialog-title"
            aria-describedby="harness-stop-dialog-description"
            className="glass-surface flex w-full flex-col gap-3 rounded-xl p-4"
          >
            <div className="flex flex-col gap-1">
              <h2 id="harness-stop-dialog-title" className="text-[length:var(--font-size-body-md)] font-semibold text-[var(--text-primary)]">Stop this work?</h2>
              <p id="harness-stop-dialog-description" className={MUTED_TEXT_CLASS}>
                This pauses “{contract.outcome}” and turns off automatic continuation for this outcome.
              </p>
            </div>
            <p className={MUTED_TEXT_CLASS}>Anything already completed stays saved.</p>
            <div className="flex flex-row justify-end gap-2">
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirmControlId(null)}>Keep it running</button>
              <button type="button" className={DANGER_BUTTON_CLASS} onClick={() => confirmControl && void dispatchControl(confirmControl)}>
                Stop this work
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function HarnessControls({
  controlsSource,
  contractsSource,
  pausesSource,
  onDispatchControl,
  state = 'active',
  errorMessage,
}: HarnessControlsProps) {
  const liveControls = useBitfieldData('harness-controls');
  const liveContracts = useBitfieldData('harness-contracts');
  const livePauses = useBitfieldData('harness-pauses');
  const controls = projectHarnessControls(controlsSource ?? liveControls);
  const contracts = projectHarnessWork(contractsSource ?? liveContracts);
  const pausedIds = projectPausedContractIds(pausesSource ?? livePauses);
  const actionable = contracts.filter((contract) => contract.status.toUpperCase() !== 'PAUSED' && !pausedIds.has(contract.id));
  const paused = contracts.filter((contract) => contract.status.toUpperCase() === 'PAUSED' || pausedIds.has(contract.id));

  return (
    <section className="flex h-full min-h-0 w-full flex-col gap-4" data-testid="harness-controls">
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--font-size-heading-lg)] font-semibold text-[var(--text-primary)]">Automatic work</h1>
        <p className={MUTED_TEXT_CLASS}>See what automatic work is advancing and stop an outcome only if you want it to end.</p>
      </div>

      {state === 'loading' ? <span className={MUTED_TEXT_CLASS} role="status" aria-live="polite">{STATE_COPY.loading}</span> : null}

      {state !== 'loading' && actionable.length === 0 && paused.length === 0 ? (
        <article className={CARD_CLASS}>
          <h2 className="text-[length:var(--font-size-heading-sm)] font-semibold text-[var(--text-primary)]">No automatic work is running</h2>
          <p className={MUTED_TEXT_CLASS}>Nothing is waiting for you.</p>
        </article>
      ) : null}

      {actionable.map((contract) => (
        <WorkCard
          key={contract.id}
          contract={contract}
          controls={controls}
          initialState={state}
          errorMessage={errorMessage}
          onDispatchControl={onDispatchControl}
        />
      ))}

      {paused.map((contract) => (
        <article key={contract.id} className={CARD_CLASS} data-testid="paused-work-card">
          <span className="text-[length:var(--font-size-caption)] text-[var(--text-muted)]">Stopped</span>
          <h2 className="text-[length:var(--font-size-heading-sm)] font-semibold text-[var(--text-primary)]">{contract.outcome}</h2>
          <p className={MUTED_TEXT_CLASS}>Automatic work will not continue this outcome.</p>
        </article>
      ))}
    </section>
  );
}

const REACT_SURFACE_MOUNT = Symbol.for('architect.commandCenter.reactSurfaceMount');
type HarnessControlsMountElement = HTMLElement & {
  [REACT_SURFACE_MOUNT]?: { root: Root };
};

export default function mount({ el, props = {} }: { el: HTMLElement; props?: Record<string, unknown> }) {
  const element = el as HarnessControlsMountElement;
  element[REACT_SURFACE_MOUNT]?.root.unmount();
  delete element[REACT_SURFACE_MOUNT];

  const root = createRoot(el);
  const record = { root };
  element[REACT_SURFACE_MOUNT] = record;
  const mountProps = props as HarnessControlsProps;
  root.render(
    <HarnessControls
      {...mountProps}
      onDispatchControl={(dispatch, _controlId, eventId, contractRef, sessionRef) => (
        dispatchHarnessControl(dispatch, contractRef, sessionRef, eventId)
      )}
    />
  );

  return () => {
    if (element[REACT_SURFACE_MOUNT] !== record) return;
    delete element[REACT_SURFACE_MOUNT];
    root.unmount();
  };
}
