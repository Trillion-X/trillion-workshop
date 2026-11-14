// The existing licensed RecordSet renderer follows an installed resource binding.
// This is a consumer of its owner, not a shadow record store or a new list UI.
import * as React from 'react';
import { createAddressedPresentationClient } from './addressed-presentation.mjs';
import { nativeResourcePresentationHost, resourcePresentationHost, onResourceAction } from './resource-presentation-host.mjs';
import { readJson } from './api';
import { RecordSet, type RecordSetAnswer, type RecordSetKept } from '../../parts/ui/show/record-views/record-set';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { Container } from '../../parts/ui/show/container';
import { refusal } from './failure';
import { focusPathFor } from './scope-focus';
import { recordFilter } from './record-filter';
import { BreadcrumbSteps } from '../../parts/ui/show/breadcrumb/mount-breadcrumb';

export type ResourcePresentationBinding = {
  address: string; generation: string | number; state_key?: string;
  read?: { operation?: string; input?: unknown };
  renderer?: unknown; tools?: unknown;
};

export function AddressedRecordSet({ binding, kept, keep, screen, loading, failed }: {
  binding: ResourcePresentationBinding; kept: RecordSetKept; keep: (value: RecordSetKept) => void;
  screen: string; loading: string; failed: string;
}) {
  const [rendered, setRendered] = React.useState<{ value: RecordSetAnswer; key: string } | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [attempt, setAttempt] = React.useState(0);
  const pendingPaint = React.useRef<{ value: RecordSetAnswer; resolve: (value: { current: boolean }) => void } | null>(null);
  const [preferences, setPreferences] = React.useState(kept);
  const inside = preferences.inside ?? [];
  const selected = inside.at(-1) as (NonNullable<RecordSetKept['inside']>[number] & { resource_binding?: ResourcePresentationBinding }) | undefined;
  const activeBinding = selected?.resource_binding ?? binding;
  const retry = React.useCallback(() => setAttempt(value => value + 1), []);
  const bindingKey = JSON.stringify(activeBinding);
  const answer = rendered?.key === bindingKey ? rendered.value : null;
  React.useEffect(() => {
    let active = true;
    setError(null); setRendered(null);
    const host = resourcePresentationHost(nativeResourcePresentationHost({ readJson }));
    const client = createAddressedPresentationClient({ ...host,
      paint(value: RecordSetAnswer) {
        if (!Array.isArray(value?.items) || !value.view || !Array.isArray(value.view.fields))
          throw new Error('This resource did not return a current list.');
        if (selected && !selected.resource_binding) {
          const resource_binding = (value.resource_views as Record<string, ResourcePresentationBinding> | undefined)?.[selected.url];
          if (!resource_binding) throw new Error('The saved view has no current resource binding.');
          const restored = { ...preferences, inside: inside.map((level, index) => index === inside.length - 1 ? { ...level, resource_binding } : level) };
          setPreferences(restored); keep(restored);
          // The resolved child must paint its own current data before readiness.
          return Promise.resolve({ current: false });
        }
        return new Promise<{ current: boolean }>(resolve => {
          if (!active) { resolve({ current: false }); return; }
          pendingPaint.current = { value, resolve };
          setRendered({ value, key: bindingKey }); setError(null);
        });
      },
      onError(error: unknown) {
        if (!active) return;
        // Failed or revoked reads can never appear as an empty current dataset.
        pendingPaint.current?.resolve({ current: false }); pendingPaint.current = null;
        setRendered(null); setError(error);
      },
    });
    const session = client.open(activeBinding);
    const stopActions = onResourceAction((envelope: ResourcePresentationBinding) => {
      if (envelope.address === activeBinding.address && envelope.generation === activeBinding.generation)
        void session.refresh().catch(() => {});
    });
    void session.ready.catch(() => {});
    return () => {
      active = false; stopActions(); client.close();
      pendingPaint.current?.resolve({ current: false }); pendingPaint.current = null;
    };
  }, [bindingKey, attempt]);
  // Readiness follows a committed React render of actual owner data, including
  // the shared meaningful empty state. Loading/error states acknowledge nothing.
  React.useLayoutEffect(() => {
    const pending = pendingPaint.current;
    if (answer && !error && pending?.value === answer) {
      pendingPaint.current = null; pending.resolve({ current: true });
    }
  }, [rendered, error, bindingKey]);
  const change = (value: RecordSetKept) => { setPreferences(value); keep(value); };
  const down = (next: string, label: string) => {
    const views = answer?.resource_views as Record<string, ResourcePresentationBinding> | undefined;
    const resource_binding = views?.[next];
    if (!resource_binding) { setError(new Error('This view has no installed resource binding.')); return; }
    change({ inside: [...inside, { url: next, label, from: answer?.view.label ?? '',
      kept: { rules: preferences.rules, group: preferences.group, view: preferences.view }, resource_binding } as NonNullable<RecordSetKept['inside']>[number]] });
  };
  const steps = inside.length ? [{ id: '0', label: inside[0].from }, ...inside.map((step, index) => ({ id: String(index + 1), label: step.label }))] : [];
  const trail = steps.length ? <Container padding="sm"><BreadcrumbSteps steps={steps} onOpen={id => {
    const depth = Number(id); change({ ...(inside[depth]?.kept ?? {}), inside: inside.slice(0, depth) });
  }} /></Container> : null;
  if (error) return <Container layout="vertical" height="full" minHeight="0">{trail}<ScreenState state={refusal(failed)(error, retry)} /></Container>;
  if (!answer) return <Container layout="vertical" height="full" minHeight="0">{trail}<ScreenState state={{ status: 'loading', label: loading, layout: 'rows' }} /></Container>;
  if (!answer.items.length) return <Container layout="vertical" height="full" minHeight="0">{trail}<ScreenState state={{ status: 'empty', icon: answer.view.empty?.icon ?? 'List', title: answer.view.empty?.title ?? 'Nothing here yet', description: answer.view.empty?.description ?? '' }} /></Container>;
  return <Container layout="vertical" height="full" minHeight="0">{trail}<RecordSet key={bindingKey} answer={answer}
    options={{ ...recordFilter, focusPath: focusPathFor(screen, answer.view.preference_key) }}
    kept={preferences} onKeep={value => change({ ...value, inside })} onInside={down} /></Container>;
}
