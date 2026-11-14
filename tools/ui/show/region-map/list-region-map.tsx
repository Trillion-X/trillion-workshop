// parts/ui/show/region-map/list-region-map.tsx
//
// PURPOSE
//   A list's records drawn on a region map (offer-region-map-view.tsx offers it to every list; this file is fetched the
//   first time a list is drawn that way, never with the page). The map is DATA kept with the saved view that is open:
//   context.settings is { regions: [{ id, label, d }], view_box, region_field, value_field?, formula?, domain?, title? }, so
//   a body, a court or a floor plan is one saved view, flippable without code. Pressing a region reads its number aloud
//   in the line under the map.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field, region or shape is named here: all of it is in the saved view's settings.
//   2. A view with no usable map says so and what it needs; it never draws an empty frame or invents regions.
//   3. Values are read the way every view reads them (a field's factValue, else read), the same as the chart view.

import React from 'react';
import { EmptyState } from '../empty-state';
import type { RecordViewContext } from '../record-views/record-views';
import { RegionMap, type MapRegion } from './RegionMap';
import { regionValuesFromRecords, type RegionMapPlacement } from './region-heat';

type Settings = RegionMapPlacement & { regions?: unknown; view_box?: unknown; title?: unknown };

const isRegion = (value: unknown): value is MapRegion => {
  const row = value as Record<string, unknown> | null;
  return Boolean(row) && typeof row!.id === 'string' && typeof row!.label === 'string' && typeof row!.d === 'string' && row!.id !== '';
};

export function ListRegionMap({ context }: { context: RecordViewContext }) {
  const settings = (context.settings ?? {}) as Settings;
  const regions = Array.isArray(settings.regions) ? settings.regions.filter(isRegion) : [];
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const byId = React.useMemo(() => new Map(context.fields.map(field => [field.id, field])), [context.fields]);
  const readField = React.useCallback((record: unknown, id: string) => {
    const field = byId.get(id);
    if (!field) return undefined;
    if (field.factValue) return field.factValue(record);
    return field.read ? field.read(record) : (record as Record<string, unknown> | null)?.[id];
  }, [byId]);
  const usable = regions.length > 0 && typeof settings.view_box === 'string' && typeof settings.region_field === 'string' && byId.has(settings.region_field);
  const values = React.useMemo(
    () => (usable ? regionValuesFromRecords(context.records, settings as RegionMapPlacement, readField) : {}),
    [usable, context.records, settings, readField],
  );
  if (!usable) {
    return (
      <EmptyState
        title="This view has no map yet"
        description="Save the view with a map: regions (id, label, path), a view_box, and region_field, the field that says which region each record belongs to."
      />
    );
  }
  const title = typeof settings.title === 'string' && settings.title ? settings.title : context.label;
  const picked = regions.find(region => region.id === pickedId) ?? null;
  const pickedValue = picked ? values[picked.id] : undefined;
  return (
    <div className="region-map-view">
      <RegionMap
        regions={regions}
        values={values}
        domain={settings.domain}
        viewBox={settings.view_box as string}
        pickedId={pickedId}
        onPick={id => setPickedId(current => (current === id ? null : id))}
        title={title}
      />
      <p className="region-map-readout" aria-live="polite">
        {picked ? `${picked.label}: ${typeof pickedValue === 'number' ? pickedValue : 'no reading'}` : 'Press a region to read it.'}
      </p>
    </div>
  );
}
