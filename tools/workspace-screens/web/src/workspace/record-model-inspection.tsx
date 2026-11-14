// The existing EEAF model, drawn with the shared record views. This projection
// owns no records, checks or annotations. Readonly facts, saved relationships and
// captured execution remain different evidence classes.
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RecordFacts, RecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { Button } from '../../parts/ui/show/button';
import { Container } from '../../parts/ui/show/container';
import { CopyButton } from '../../parts/ui/show/copy-button/CopyButton';
import { SchemaValueView } from '../../parts/ui/show/schema-value-view/SchemaValueView';
import { LONG_TEXT_CHARS } from '../../parts/ui/show/schema-value-view/value-shape';
import { BreadcrumbSteps } from '../../parts/ui/show/breadcrumb/mount-breadcrumb';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { readJson } from './api';
import { refusal } from './failure';
import { openScreenOn, useOfferedScreens } from './open-screen';
import { recordFilter } from './record-filter';
import { traceReferenceTarget } from './activity-trace-view.mjs';
import { modelRelations, modelLabels, modelAnchors, modelAnchorTarget, modelReferenceTarget, modelValueTree, modelValueFields,
  modelValueCollections, modelValueSelection, modelScopedAnchors, modelPathLabel, modelValueIsCollection } from './record-model-view.mjs';

export type ModelRead = {
  id: string; requested_id?: string; type?: string | null;
  facts?: { path: (string | number)[]; value: unknown; value_kind?: string }[] | null;
  parts?: { id: string; role: string; ordinal?: number | null }[];
  holders?: { id: string; role: string; ordinal?: number | null }[];
  labels?: unknown; fields?: { id: string; label: string }[];
  complete?: boolean; next?: string | null; version?: unknown;
  [key: string]: unknown;
};
type Named = { id?: string; ref?: string; title?: string | null; label?: string | null; open?: any; target?: any; open_href?: string; version?: string; missing?: boolean | null; unavailable?: boolean };

/** Keep a readable name beside the exact identity and an independent inspection
 *  action. A name cannot change what opens, and no target ever grants access. */
export function RecordReference({ value, current = '', named, kind = 'trace', inspect = true, compact = false }: {
  value: string; current?: string; named?: Named; kind?: 'trace' | 'work'; inspect?: boolean; compact?: boolean;
}) {
  const fallback = traceReferenceTarget(value, kind);
  const offered = useOfferedScreens();
  const target = modelReferenceTarget(value, named, offered, window.location.origin) ?? fallback;
  const label = named?.title ?? named?.label ?? value;
  const open = (event: React.MouseEvent, chosen: any) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation();
    openScreenOn(chosen.screen, chosen.input, label);
  };
  const labelClass = compact ? 'min-w-0 truncate' : 'min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]';
  return <span className={compact ? 'inline-flex min-w-0 max-w-full items-center gap-1' : 'inline-flex max-w-full flex-wrap items-start gap-1'} onClick={event => event.stopPropagation()}>
    {value === current && target.screen === fallback.screen
      ? <span className={labelClass} title={value}>{label}</span>
      : <a className={`${labelClass} underline underline-offset-2`} href={target.href} title={value} onClick={event => open(event, target)}>{label}</a>}
    {!compact ? <CopyButton text={value} label="Copy exact reference" iconOnly /> : null}
    {!compact && inspect && target.screen !== fallback.screen ? <a className="text-xs underline" href={fallback.href} onClick={event => open(event, fallback)}>Inspect</a> : null}
  </span>;
}

function FactValue({ value, labels, current }: { value: unknown; labels: Map<string, Named>; current: string }) {
  if (typeof value === 'boolean') return <span>{value ? '✓ Yes' : '○ No'} <span className="text-xs text-muted-foreground">(stored value)</span></span>;
  if (value === null) return <span className="text-muted-foreground">Null (stored value)</span>;
  if (value === '') return <span className="text-muted-foreground">Empty text (stored value)</span>;
  if (typeof value === 'string' && labels.has(value)) return <RecordReference value={value} current={current} named={labels.get(value)} />;
  if (Array.isArray(value) && !value.length) return <span className="text-muted-foreground">Empty array (0 items)</span>;
  if (Array.isArray(value)) return <span className="flex min-w-0 max-w-full flex-col gap-1">{value.map((one, index) => <span className="min-w-0 max-w-full" key={index}><FactValue value={one} labels={labels} current={current} /></span>)}</span>;
  if (typeof value === 'object' && !Object.keys(value).length) return <span className="text-muted-foreground">Empty object (0 fields)</span>;
  if (typeof value === 'object') return <SchemaValueView value={value} designed={false} />;
  return <span className="min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">{String(value ?? '')}</span>;
}

// RecordFacts omits an empty preview value before drawing it. These readable
// sentinels keep actual empty values visible; FactValue still draws their type.
const keptText = (value: unknown): string => value === null ? 'Null (stored value)' : value === '' ? 'Empty text (stored value)'
  : Array.isArray(value) ? JSON.stringify(value) : typeof value === 'object' ? JSON.stringify(value) : String(value);

function AnchorAction({ anchor }: { anchor: any }) {
  const target = modelAnchorTarget(anchor);
  return target ? <span className="flex max-w-full flex-wrap gap-2"><a className="text-sm underline" href={target.href} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation(); openScreenOn(target.screen, target.input, target.title);
  }}>{target.title}</a>{target.range?.[1] != null ? <span className="text-sm text-muted-foreground">through {target.range[1]}s</span> : null}</span> : null;
}

/** One selected value and the collections immediately inside it. The existing
 * record views own search, choice of view, counts and virtualized rendering.
 * This knows object/array shape and exact field paths, never a domain field. */
function ValueBrowser({ model, labels, part }: { model: ModelRead; labels: Map<string, Named>; part?: unknown }) {
  const tree = React.useMemo(() => modelValueTree(model), [model]);
  const initial = React.useMemo(() => modelValueSelection(tree, part), [tree, part]);
  const [path, setPath] = React.useState<(string | number)[]>(initial.path);
  const [focus, setFocus] = React.useState(initial.state === 'addressed' ? 1 : 0);
  const heading = React.useRef<HTMLHeadingElement>(null);
  const node = tree.nodes.get(JSON.stringify(path)) ?? tree.root;
  const facts = modelValueFields(tree, node.path, model);
  const collections = modelValueCollections(tree, node.path);
  const anchors = React.useMemo(() => modelAnchors(model), [model]);
  const scopedAnchors = modelScopedAnchors(anchors, node.path, tree);
  const open = (id: string) => {
    const next = tree.nodes.get(id);
    if (next) { setPath(next.path); setFocus(value => value + 1); }
  };
  React.useEffect(() => {
    if (!focus) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [focus]);
  const steps = [{ id: '[]', label: 'Record' }, ...node.path.map((key: string | number, index: number) => ({
    id: JSON.stringify(node.path.slice(0, index + 1)), label: modelPathLabel([key], index === 0 ? model : {}),
  }))];
  const descriptors: FieldDescriptor[] = facts.map((fact: any) => ({
    id: fact.id, label: fact.label, editable: false,
    // The shared facts owner already gives excerpts the full width. Use that
    // same treatment for long prose or labels rather than squeezing phone text.
    kind: fact.label.length > 36 || typeof fact.value === 'string' && (fact.value.length > LONG_TEXT_CHARS || fact.value.includes('\n')) ? 'excerpt' : 'text',
    read: () => keptText(fact.value), render: () => <FactValue value={fact.value} labels={labels} current={model.id} />,
  }));
  const collection = modelValueIsCollection(node) ? node : collections.length === 1 ? collections[0] : null;
  const rows = collection ? collection.children.map((child: any) => ({ ...child, fields: modelValueFields(tree, child.path, model) })) : collections;
  const scalarColumns = new Map<string, any>();
  if (collection) for (const row of rows) for (const fact of row.fields) {
    const id = JSON.stringify(fact.relative);
    if (!scalarColumns.has(id)) scalarColumns.set(id, { id, label: fact.label, relative: fact.relative });
  }
  const columns: FieldDescriptor[] = [{ id: 'path', label: collection ? 'Item' : 'Collection', ruleKind: 'text', filterable: true, width: 100,
    read: row => modelPathLabel(row.path.slice(node.path.length), node.path.length ? {} : model) }];
  if (collection) for (const [index, column] of [...scalarColumns.values()].entries()) {
    const read = (row: any) => row.fields.filter((fact: any) => JSON.stringify(fact.relative) === column.id).map((fact: any) => keptText(fact.value)).join('\n');
    columns.push({ id: `value:${column.id}`, label: column.label, ruleKind: 'text', filterable: true, groupable: true, preview: true,
      width: 300, hiddenByDefault: index >= 3 && column.relative.length > 1,
      read, render: row => <span className="block min-w-0 truncate" title={read(row)}>{read(row)}</span> });
  } else columns.push({ id: 'count', label: 'Items', ruleKind: 'number', width: 100, preview: true, read: row => row.children.length });
  const parent = node.path.length ? tree.nodes.get(JSON.stringify(node.path.slice(0, -1))) : null;
  const position = parent?.children.findIndex((child: any) => child.id === node.id) ?? -1;
  const anchorFields: FieldDescriptor[] = [
    { id: 'label', label: 'Location', ruleKind: 'text', filterable: true, width: 250,
      read: row => modelPathLabel(row.path.slice(node.path.length), node.path.length ? {} : model) || 'This value' },
    { id: 'record', label: 'Source record', ruleKind: 'text', filterable: true, width: 360, preview: true,
      render: row => <span className="flex min-w-0 max-w-full items-center gap-1"><RecordReference value={row.record} named={labels.get(row.record)} compact /><CopyButton text={row.record} label="Copy exact reference" iconOnly /></span> },
    { id: 'part', label: 'Addressed part', ruleKind: 'text', filterable: true, width: 260, preview: true,
      read: row => row.part ? JSON.stringify(row.part) : 'Whole record', render: row => <AnchorAction anchor={row} /> },
  ];
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Saved value browser" data-model-path={node.id}>
    <BreadcrumbSteps steps={steps} onOpen={open} />
    <h3 ref={heading} tabIndex={-1} className="text-base font-medium break-words [overflow-wrap:anywhere]" data-addressed={initial.state === 'addressed' && node.id === JSON.stringify(initial.path) ? 'true' : undefined}>{node.label}</h3>
    {initial.state === 'unavailable' ? <p className="text-sm" role="status">The addressed field is not available in the facts returned for this version. The available record is shown below.</p>
      : initial.state === 'unsupported' ? <p className="text-sm" role="status">This locator is preserved above. Its kind does not select a field in this view; its owner may provide another way to open it.</p> : null}
    {modelValueIsCollection(parent) ? <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={position <= 0} onClick={() => open(parent.children[position - 1].id)}>Previous item</Button>
      <span className="text-sm">Item {position + 1} of {parent.children.length}</span>
      <Button size="sm" variant="outline" disabled={position + 1 >= parent.children.length} onClick={() => open(parent.children[position + 1].id)}>Next item</Button>
    </div> : null}
    {facts.length > 24 ? <Container minWidth="0" minHeight="0" maxHeight="min(65vh, 40rem)" overflow="y-auto">
      <RecordViews label="Fields" {...recordFilter} records={facts} identify={row => row.id} onOpen={id => { const field = facts.find((one: any) => one.id === id); if (field) open(JSON.stringify(field.path)); }}
        fields={[{ id: 'label', label: 'Field', ruleKind: 'text', filterable: true, width: 300 },
          { id: 'value', label: 'Stored value', ruleKind: 'text', filterable: true, width: 500, preview: true, read: row => keptText(row.value) }]}
        preferenceKey={`trillion-model-fields:${node.id}`} defaultView="table" emptyMessage="No fields match." />
    </Container> : facts.length ? <RecordFacts fields={descriptors} record={model} recordId={`${model.id}:${node.id}`} label={node.label} /> : null}
    {collection || collections.length ? <section className="min-w-0" aria-label="Nested values">
      <Container minWidth="0" minHeight="0" maxHeight="min(65vh, 40rem)" overflow="y-auto">
      <RecordViews key={`${model.id}:${node.id}:${collection?.id ?? 'collections'}`} label={collection?.label ?? 'Collections'} {...recordFilter}
        fields={columns} records={rows} identify={row => row.id} onOpen={open}
        preferenceKey={`trillion-model-values:${collection?.id ?? node.id}`} defaultView={window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table'}
        detailLevels={{ default_level: 'values', levels: [{ id: 'values', label: 'Saved values', fields: 3, tile_px: 360 }, { id: 'names', label: 'Names only', fields: 0, tile_px: 200 }] }}
        emptyMessage="This collection has no returned items." />
      </Container>
    </section> : null}
    {scopedAnchors.length ? <section className="min-w-0" aria-label="Sources within this value">
      <p className="mb-2 text-sm text-muted-foreground">References within this value identify where its recorded claims point. Open the exact source or addressed part to assess support.</p>
      <Container minWidth="0" minHeight="0" maxHeight="min(65vh, 40rem)" overflow="y-auto">
      <RecordViews key={`anchors:${node.id}`} label="Addressed evidence" {...recordFilter} fields={anchorFields} records={scopedAnchors} identify={row => row.id}
        preferenceKey={`trillion-model-anchors:${node.id}`} defaultView={window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table'}
        onOpen={id => { const target = modelAnchorTarget(scopedAnchors.find((anchor: any) => anchor.id === id)); if (target) openScreenOn(target.screen, target.input, target.title); }}
        emptyMessage="No addressed evidence matches." />
      </Container>
    </section> : null}
  </section>;
}

function InspectionBody({ model, valid, known, after, readVersion, nextPage, retry, part }: {
  model: ModelRead; valid: string; known: string; after: string;
  readVersion: (valid: string, known: string) => void; nextPage: () => void; retry: () => void; part?: unknown;
}) {
  const labels = modelLabels(model) as Map<string, Named>;
  const own = labels.get(model.id);
  const relations = modelRelations(model);
  const historical = Boolean(valid || known);
  const coverage = model.coverage as { facts?: string; history?: string } | undefined;
  const historyUnsupported = coverage?.history === 'unsupported';
  const historicalUnsupported = coverage?.facts === 'historical_unsupported';
  const sourceUnavailable = coverage?.facts === 'unavailable';
  const fields: FieldDescriptor[] = [
    { id: 'title', label: 'Related record', ruleKind: 'text', width: 320, filterable: true, render: row => <RecordReference value={row.ref} current={model.id} named={row.named} /> },
    { id: 'role_label', label: 'Relationship', ruleKind: 'text', width: 190, filterable: true, groupable: true, preview: true },
    { id: 'direction', label: 'Direction', ruleKind: 'choice', width: 140, filterable: true, groupable: true, preview: true,
      read: row => row.direction === 'outgoing' ? 'This record names' : 'Names this record' },
    { id: 'position', label: 'Position', ruleKind: 'number', width: 100, sortable: true, preview: true },
    { id: 'basis', label: 'Evidence basis', ruleKind: 'text', width: 300, preview: true },
  ];
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Record and its evidence">
    <header className="flex min-w-0 flex-col gap-2">
      <h2 className="text-lg font-semibold break-words">{own?.title ?? own?.label ?? 'Record details'}</h2>
      <RecordReference value={model.id} current={model.id} named={own} />
      <p className="text-sm text-muted-foreground">{historicalUnsupported
        ? 'An earlier version is not available from this record’s owner. Current facts are not substituted for the requested version.' : historical
        ? 'Historical saved facts. Relationships, record names and field labels describe their current state; they do not establish which version was used.'
        : 'Current saved facts and relationships. Open the captured work below to check what was actually done.'}</p>
      {part ? <div className="min-w-0 text-sm"><strong>Addressed part</strong><SchemaValueView value={part} designed={false} /></div> : null}
    </header>
    {historyUnsupported ? <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <p>Earlier versions are not available in this view.</p>
      {historical ? <Button type="button" variant="outline" size="sm" onClick={() => readVersion('', '')}>Current record</Button> : null}
    </div> : <details>
      <summary className="cursor-pointer text-sm">Inspect an earlier version</summary>
      <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        readVersion(String(data.get('valid') ?? '').trim(), String(data.get('known') ?? '').trim());
      }}>
        <label className="flex min-w-0 flex-col gap-1 text-sm">True at (ISO time)<input className="w-full rounded-md border bg-background p-2" name="valid" defaultValue={valid} placeholder="2026-10-11T12:00:00Z" /></label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">Known at (ISO time)<input className="w-full rounded-md border bg-background p-2" name="known" defaultValue={known} placeholder="2026-10-11T12:00:00Z" /></label>
        <Button type="submit" variant="outline" size="sm">Read version</Button>
        {historical || after ? <Button type="button" variant="ghost" size="sm" onClick={() => readVersion('', '')}>Current record</Button> : null}
      </form>
    </details>}
    {sourceUnavailable ? <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">
      <p>This record could not be read from its owner. Its saved facts are unavailable, rather than empty.</p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>Retry record read</Button>
    </div> : !model.facts?.length ? <p className="text-sm text-muted-foreground" role="status">{historicalUnsupported
      ? 'No historical field values are shown.'
      : 'No saved field values were returned for this record at the requested version. This does not establish that no work occurred.'}</p>
      : <ValueBrowser key={`${model.id}:${valid}:${known}`} model={model} labels={labels} part={part} />}
    <section className="min-w-0" aria-label="Record relationships">
      <RecordViews label="Relationships" {...recordFilter} fields={fields} records={relations} identify={row => row.id}
        preferenceKey="trillion-record-relationships" defaultView={window.matchMedia('(max-width: 600px)').matches ? 'gallery' : 'table'}
        emptyMessage="No relationships were returned in this page."
        onOpen={id => { const row = relations.find(row => row.id === id); if (row) openScreenOn('trillion.activity-trace', { item: row.ref }, row.title); }} />
      <p className="mt-2 text-sm text-muted-foreground" role="status">{model.complete === false ? 'The model index or this relationship page is incomplete.' : 'Relationships are saved declarations; they do not by themselves prove an action.'}</p>
      {model.next ? <Button type="button" className="mt-2" variant="outline" size="sm" onClick={nextPage}>Next relationship page</Button> : null}
    </section>
  </section>;
}

/** Uses the shared read lifecycle, including same-target retry and explicit errors.
 *  A history read is requested only by the person, never guessed from a relation. */
export function mountRecordModelInspection(element: HTMLElement, item: string, options: {
  part?: unknown; resolved: (model: ModelRead | null) => void;
}): () => void {
  let root: Root | null = null;
  let valid = '', known = '', after = '';
  const screen = loadScreen(element, {
    loading: { label: 'Reading this record and its connections', layout: 'rows' },
    read: () => readJson<ModelRead>(`/work/api/records/model?${new URLSearchParams({ id: item, inspect: 'true', limit: '50', ...(valid ? { valid } : {}), ...(known ? { known } : {}), ...(after ? { after } : {}) })}`),
    failed: (error, retry) => { options.resolved(null); return refusal('This record could not be inspected')(error, retry); },
    clear: () => { root?.unmount(); root = null; },
    draw: model => {
      options.resolved(model);
      root = createRoot(element);
      root.render(<InspectionBody model={model} valid={valid} known={known} after={after} part={options.part}
        readVersion={(nextValid, nextKnown) => { valid = nextValid; known = nextKnown; after = ''; screen.reload(); }}
        nextPage={() => { after = String(model.next ?? ''); screen.reload(); }} retry={() => screen.reload()} />);
    },
  });
  return () => { screen.dispose(); root?.unmount(); root = null; };
}
