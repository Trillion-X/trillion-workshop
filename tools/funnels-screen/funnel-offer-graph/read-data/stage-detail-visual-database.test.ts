import { describe, expect, it } from 'vitest';
import { extractFieldValue } from '@/packages/visual-database/read-data/visual-database';
import { buildFunnelStageDetailVisualDatabaseProjection } from './stage-detail-visual-database';

const descriptor = {
  kind: 'visual-database.view-descriptor',
  id: 'visit-detail',
  fields: {
    kind: 'visual-database.fields',
    version: 3,
    descriptors: [
      { id: 'source', label: 'Source', role: 'title', paths: [['fields', 'source']] },
      { id: 'visits', label: 'Visits', role: 'metric', paths: [['fields', 'visits']], shape: 'number' },
    ],
  },
  views: {
    kind: 'visual-database.views',
    version: 3,
    views: [
      { id: 'visit-detail', label: 'Who is at this step', kind: 'table', columns: { order: ['source', 'visits'] } },
    ],
  },
};

describe('buildFunnelStageDetailVisualDatabaseProjection', () => {
  it('decodes a self-contained visual-database stage detail descriptor', () => {
    const projection = buildFunnelStageDetailVisualDatabaseProjection(descriptor, [
      { id: 'detail-1', fields: { source: 'Organic', visits: 12 } },
    ]);
    expect(projection?.initialViewId).toBe('visit-detail');
    expect(projection?.model.views.map((view) => view.id)).toEqual(['visit-detail']);
    expect(projection?.model.records).toHaveLength(1);
    const sourceField = projection!.model.fields.find((field) => field.id === 'source')!;
    expect(extractFieldValue(projection!.model.records[0]!, sourceField)).toBe('Organic');
  });

  it('fails soft on a malformed descriptor', () => {
    expect(buildFunnelStageDetailVisualDatabaseProjection({ id: 'bad' }, [])).toBeNull();
  });
});
