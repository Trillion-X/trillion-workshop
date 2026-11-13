// src/workspace/record-set-screen.tsx
//
// PURPOSE
//   Record set (entry `record-set`): any list of the person's records whose store answer describes itself, drawn on the
//   one shared record views (parts/ui/show/record-views/record-set.tsx). The surface row names where its records are
//   read (`surface_input.records_url`); the answer's `view` DATA names the columns, the empty words and how an opened
//   record is drawn. Sent (records/sent-kinds.json, /work/api/sent) is one such list; another list is one surface row
//   and its store answer, with no screen code.
//   Each placement keeps its own rules, grouping, view and depth (parts/ui/show/placement-kept, input `kept`): one
//   Spend piece can stay on Cloudflare grouped by store while another shows the total. Opening a record that is made of
//   records (`view.inside`) goes one level down in place, and the steps above it lead back up.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list is named here: what to read comes from the surface row, how to draw it from the answer.
//   2. Only what the store answered is drawn; having nothing is said with the answer's own empty words.
//   3. The list follows the store: a change to the person's records reads it again.
//   4. Every element is a shared part; this file writes no markup.
//   5. What a placement keeps is its own DATA, written through the placement (keepInPlacement), never a preference
//      shared by every placement of the list.

import * as React from 'react';
import { RecordSet, type RecordSetAnswer, type RecordSetKept } from '../../parts/ui/show/record-views/record-set';
import { focusPathFor } from './scope-focus';
import { BreadcrumbSteps } from '../../parts/ui/show/breadcrumb/mount-breadcrumb';
import { Container } from '../../parts/ui/show/container';
import { ScreenState, mountScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { keepInPlacement, keptIn } from '../../parts/ui/show/placement-kept/placement-kept';
import { readJson } from './api';
import { refusal } from './failure';
import { goTo } from './open-screen';
import { recordFilter } from './record-filter';
import { AI_WORK, onStoreChange } from './store-changes';
import type { ScreenProps } from './lazy-screen';
import { AddressedRecordSet, type ResourcePresentationBinding } from './addressed-record-set';

function RecordSetRoot({ url: top, loading, failed, kept: first, keep, screen }: { url: string; loading: string; failed: string; kept: RecordSetKept; keep: (kept: RecordSetKept) => void; screen: string }) {
  const [kept, setKept] = React.useState(first);
  const change = React.useCallback((next: RecordSetKept) => { setKept(next); keep(next); }, [keep]);
  const inside = kept.inside ?? [];
  const url = inside.length ? inside[inside.length - 1].url : top;
  const loaded = useScreenLoad(url, {
    loading: { label: loading, layout: 'rows' },
    read: () => readJson<RecordSetAnswer>(url),
    empty: answer => (answer.items.length ? null : {
      status: 'empty', icon: answer.view.empty?.icon ?? 'List', title: answer.view.empty?.title ?? 'Nothing here yet',
      description: answer.view.empty?.description ?? '',
    }),
    failed: refusal(failed),
  });
  const { reload } = loaded;
  React.useEffect(() => onStoreChange(() => reload(), AI_WORK), [reload]);
  // Going down keeps where it went; each level starts with its own rules and grouping, and going back up restores the
  // ones the level above had.
  const down = (next: string, label: string) => change({ inside: [...inside, { url: next, label, from: loaded.value?.view.label ?? '', kept: { rules: kept.rules, group: kept.group, view: kept.view } }] });
  const upTo = (depth: number) => {
    change({ ...(inside[depth]?.kept ?? {}), inside: inside.slice(0, depth) });
  };
  const steps = inside.length ? [{ id: '0', label: inside[0].from }, ...inside.map((step, index) => ({ id: String(index + 1), label: step.label }))] : [];
  const trail = steps.length ? <Container padding="sm"><BreadcrumbSteps steps={steps} onOpen={id => upTo(Number(id))} /></Container> : null;
  if (loaded.state) return <Container layout="vertical" height="full" minHeight="0">{trail}<ScreenState state={loaded.state} /></Container>;
  return (
    <Container layout="vertical" height="full" minHeight="0">
      {trail}
      <RecordSet key={url} answer={loaded.value} options={{ ...recordFilter, focusPath: focusPathFor(screen, loaded.value.view.preference_key) }} kept={kept} onKeep={next => change({ ...next, inside })} onInside={down} onActionComplete={reload} />
    </Container>
  );
}

export function mountRecordSetScreen(element: HTMLElement, props: ScreenProps): () => void {
  const screen = element.closest('[data-trillion-screen]')?.getAttribute('data-trillion-screen') ?? 'record-set';
  const input = props.surfaceInput ?? {};
  const binding = input.resource_binding as ResourcePresentationBinding | undefined;
  if (binding) {
    const keep = (kept: RecordSetKept) => keepInPlacement(element, kept as Record<string, unknown>);
    return mountReactSurface(element, <AddressedRecordSet key={JSON.stringify(binding)} binding={binding} screen={screen} kept={keptIn(input) as RecordSetKept} keep={keep}
      loading={typeof input.loading === 'string' ? input.loading : 'Loading'} failed={typeof input.failed === 'string' ? input.failed : 'This list could not load'} />);
  }
  const url = typeof input.records_url === 'string' ? input.records_url : '';
  if (!url) {
    mountScreenState(element, { status: 'empty', icon: 'List', title: 'No list was named', description: 'Open a list from the sidebar.', action: goTo('Open Home', 'trillion.home') });
    return () => element.replaceChildren();
  }
  const loading = typeof input.loading === 'string' ? input.loading : 'Loading';
  const failed = typeof input.failed === 'string' ? input.failed : 'This list could not load';
  const keep = (kept: RecordSetKept) => keepInPlacement(element, kept as Record<string, unknown>);
  return mountReactSurface(element, <RecordSetRoot url={url} loading={loading} failed={failed} kept={keptIn(input) as RecordSetKept} keep={keep} screen={screen} />);
}
