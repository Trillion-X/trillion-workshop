import React, { useMemo, useState } from 'react';
import { saveSpace } from '../do-work/save-space';
import { isAdmittedSpaceScope, decodeOpenDescriptor, projectCycleSafeSpaces } from '../read-data/read-composed-spaces';
import { useComposedSpaces } from '../read-data/use-composed-spaces';
import { SpaceCollection } from './SpaceCollection';

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
  : [];

export function SpacesView({ projection, scope, surfaceSpaceId }: { projection?: unknown; scope?: unknown; surfaceSpaceId?: string }) {
  const [refresh, setRefresh] = useState(0);
  const [descriptorRef, setDescriptorRef] = useState('');
  const [title, setTitle] = useState('');
  const admittedScope = isAdmittedSpaceScope(scope) ? scope : null;
  const spaces = useComposedSpaces(projection, admittedScope, refresh);
  const descriptorRows = records(projection && typeof projection === 'object' ? (projection as { descriptors?: unknown }).descriptors : []);
  const descriptors = useMemo(() => descriptorRows.map(decodeOpenDescriptor), [descriptorRows]);
  const visible = surfaceSpaceId ? spaces?.filter((space) => space.spaceId === surfaceSpaceId || space.id === surfaceSpaceId) : spaces;
  const selected = descriptors.find((descriptor) => descriptor.ref === descriptorRef) ?? null;
  const graph = visible?.[0] && spaces ? projectCycleSafeSpaces(spaces, visible[0].id) : null;

  async function create() {
    if (!descriptorRef || !title.trim() || !admittedScope) return;
    await saveSpace({
      scopeRef: admittedScope.subject_ref,
      kindRef: descriptorRef,
      layoutRef: selected?.layout_ref || '',
      title,
      expectedRevision: 0,
      idempotencyRef: crypto.randomUUID(),
    // The new space's ref is minted here, beside the idempotency ref this surface
    // already mints. A surface's entropy is an INPUT the log records; the shared
    // module cannot mint it because the same file holds a target the engine replays.
    }, () => crypto.randomUUID());
    setDescriptorRef(''); setTitle(''); setRefresh((value) => value + 1);
  }

  if (spaces === null) return <div aria-busy="true">Loading spaces…</div>;
  return <section>
    <header><h1>{surfaceSpaceId ? 'Space' : 'Spaces'}</h1>{!surfaceSpaceId && <p>Choose a descriptor to create an open, owner-composed space.</p>}</header>
    {!surfaceSpaceId && <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <select aria-label="Space descriptor" value={descriptorRef} onChange={(event) => setDescriptorRef(event.target.value)}>
        <option value="">Choose a descriptor</option>
        {descriptors.map((descriptor) => <option key={descriptor.ref} value={descriptor.ref}>{descriptor.label}</option>)}
      </select>
      <input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <button disabled={!descriptorRef || !title.trim() || !admittedScope}>Create space</button>
    </form>}
    <div>{visible?.length ? visible.map((space) => <article key={space.id} data-space-ref={space.id}>
      <strong>{space.title}</strong><small>{space.subtitle}</small><span>{decodeOpenDescriptor({ ref: space.kind }).label}</span>
      <SpaceCollection items={space.items} />
      {graph?.cycle_refs.length ? <p role="status">Nested space cycle: {graph.cycle_refs.join(', ')}</p> : null}
      {graph?.truncated ? <p role="status">Nested space view reached its safe depth limit.</p> : null}
    </article>) : <p>{surfaceSpaceId ? 'This space is no longer available.' : 'No spaces are available.'}</p>}</div>
  </section>;
}
