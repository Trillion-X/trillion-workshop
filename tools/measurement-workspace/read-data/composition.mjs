import data from '../DATA.json' with { type: 'json' };
import ledgerData from '../../measurement-ledger/DATA.json' with { type: 'json' };
import { aggregate } from '../../measurement-ledger/read-data/ledger.mjs';
const SUMMARY_DIMS = ['provider', 'operation', 'metric', 'evidence_kind', 'metric_kind', 'aggregation', 'unit', 'currency', 'scenario_id', 'source_revision', 'run_id', 'window_start', 'window_end', 'scope'];

const readOptions = (listId, { order = 'a', view } = {}) => ({
  list_id: listId,
  order,
  view: {
    id: view.id,
    label: view.label,
    search: '',
    rules: view.filter ? {
      kind: 'group', combinator: 'and', negate: false,
      rules: [{ kind: 'rule', field: view.filter.field, operator: view.filter.operator, params: { values: view.filter.values } }],
    } : { kind: 'group', combinator: 'and', negate: false, rules: [] },
    sort: (view.sort ?? []).map(({ field, direction }) => ({ field, direction })),
    groups: (view.group_by ?? []).map(field => ({ field })),
    columns: { order: view.columns ?? [], hidden: [] },
    time_zone: data.time_zone,
  },
});

function canonicalList(kind) {
  const authored = data.lists[kind];
  const source = ledgerData.list_schemas[kind];
  if (!authored || !source || authored.id !== source.id.slice('list:'.length)) throw new TypeError(`Measurement list does not match ledger schema: ${kind}`);
  const sourceFields = source.value.fields;
  const sourceIds = new Set(sourceFields.map(field => field.id));
  const overrides = new Map((authored.fields ?? []).map(field => [field.id, field]));
  const fields = sourceFields.map(field => ({ ...field, label: overrides.get(field.id)?.label ?? field.label }));
  fields.push(...(authored.fields ?? []).filter(field => !sourceIds.has(field.id)));
  return { ...source.value, label: authored.label, about: authored.about, fields };
}

export function listRecord(list) {
  const kind = Object.keys(data.lists).find(key => data.lists[key].id === list?.id);
  if (!kind) throw new TypeError('Unknown measurement list composition');
  const { views: _views, ...value } = list;
  return { id: `list:${list.id}`, type: 'list', value: { ...canonicalList(kind), ...value, row_type: canonicalList(kind).row_type, title_field: canonicalList(kind).title_field, fields: canonicalList(kind).fields } };
}

export function viewRecords(kind) {
  const list = data.lists[kind];
  if (!list) throw new TypeError(`Unknown measurement list: ${kind}`);
  return list.views.map(view => ({
    id: `list-view:${list.id}:${view.id}`,
    type: 'list-view',
    value: readOptions(list.id, { order: 'a', view: view.id === 'all' ? { ...view, columns: [...new Set([...canonicalList(kind).fields.map(field => field.id), ...(view.columns ?? [])])] } : view }),
  }));
}

export function accountComposition() {
  return Object.values(data.lists).flatMap(list => [
    listRecord(list),
    ...viewRecords(Object.keys(data.lists).find(key => data.lists[key] === list)),
  ]);
}

const valueOf = row => row?.value && typeof row.value === 'object' ? row.value : row;

export function overview(observations = [], forecasts = [], billings = []) {
  const rows = observations.map(valueOf);
  const groups = aggregate(rows, { groupBy: SUMMARY_DIMS });
  const measured = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'measured' ? group.count : 0), 0);
  const assumed = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'assumed' ? group.count : 0), 0);
  const unknown = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'unknown' ? group.count : 0), 0);
  const partial = groups.reduce((sum, group) => sum + group.partial_count, 0);
  const corrections = rows.filter(row => row.corrects_event_id).length;
  return {
    measured_rows: measured,
    assumed_rows: assumed,
    unknown_rows: unknown,
    partial_rows: partial,
    correction_rows: corrections,
    forecast_versions: forecasts.length,
    billing_rows: billings.length,
    retry_unknown_rows: groups.reduce((sum, group) => sum + group.retry_unknown_count, 0),
    error_unknown_rows: groups.reduce((sum, group) => sum + group.error_unknown_count, 0),
    incomplete: groups.some(group => group.completeness !== 'complete'),
    groups,
  };
}

export function forecastComponents(forecastRecord) {
  const forecast = valueOf(forecastRecord);
  if (!Array.isArray(forecast.components)) return [];
  return forecast.components.map((component, index) => ({
    id: `${forecast.forecast_id}:v${forecast.version}:component:${index}`,
    value: {
      forecast_id: forecast.forecast_id,
      version: forecast.version,
      source_revision: forecast.source_revision,
      created_at: forecast.created_at,
      completeness: forecast.completeness,
      ...component,
    },
  }));
}

export function filterObservations(observations, { provider = '', operation = '', scope = '' } = {}) {
  const normalized = { provider: provider.trim().toLowerCase(), operation: operation.trim().toLowerCase() };
  return observations.filter(record => {
    const row = valueOf(record);
    return (!normalized.provider || String(row.provider ?? '').toLowerCase().includes(normalized.provider))
      && (!normalized.operation || String(row.operation ?? '').toLowerCase().includes(normalized.operation))
      && (!scope || row.scope === scope);
  });
}

export const workspaceData = data;
