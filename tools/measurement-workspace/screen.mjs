import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, mountReactSurface } from '@trillion/ui';
import { aggregate } from './ledger.mjs';

const h = React.createElement;
const MAX_PAGES = 20;
const SUMMARY_DIMS = ['provider', 'operation', 'metric', 'evidence_kind', 'metric_kind', 'aggregation', 'unit', 'currency', 'scenario_id', 'source_revision', 'run_id', 'window_start', 'window_end', 'scope'];
const kinds = [
  ['Observation history', 'observations'],
  ['Forecast versions', 'forecasts'],
  ['Billing records', 'billing'],
];
const scopeTone = scope => scope === 'measured' ? 'success' : scope === 'assumed' ? 'warning' : 'neutral';
const rowValue = row => row?.value && typeof row.value === 'object' ? row.value : row;
const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
const sorted = rows => [...rows].sort((a, b) => String(rowValue(b).observed_at ?? rowValue(b).created_at ?? '').localeCompare(String(rowValue(a).observed_at ?? rowValue(a).created_at ?? '')));

async function readAll(host, requestName, refreshKey) {
  const records = [];
  let after;
  let pages = 0;
  do {
    const request_key = `measurement-workspace:${refreshKey}:${requestName}:${pages}`;
    const raw = await host.call(requestName, { request_key, ...(after ? { after } : {}) });
    const result = raw?.structuredContent ?? raw?.result ?? raw;
    if (!Array.isArray(result?.records)) throw new Error(`The ${requestName} read did not return records.`);
    records.push(...result.records);
    after = result.next;
    pages++;
  } while (after && pages < MAX_PAGES);
  return { records, complete: !after, next: after ?? null };
}

function valueCell(value) {
  if (value === null || value === undefined) return 'Unknown';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function SummaryCard({ label, value, note }) {
  return h(Card, { className: 'measurement-summary-card' },
    h('p', null, label),
    h('strong', null, value),
    note ? h('p', null, note) : null,
  );
}

function DataTable({ columns, rows, onOpen }) {
  if (!rows.length) return h('p', null, 'No records yet. Coverage stays unknown until source rows arrive.');
  return h(Table, null,
    h(TableHeader, null, h(TableRow, null, ...columns.map(([id, label]) => h(TableHead, { key: id }, label)), h(TableHead, null, 'Detail'))),
    h(TableBody, null, ...rows.map((record, index) => {
      const row = rowValue(record);
      const id = record.id ?? row.event_id ?? row.forecast_id ?? row.billing_id ?? String(index);
      return h(TableRow, { key: id },
        ...columns.map(([field]) => {
          const value = row[field];
          return h(TableCell, { key: field }, field === 'scope'
            ? h(Badge, { variant: scopeTone(value) }, text(value))
            : valueCell(value));
        }),
        h(TableCell, { key: 'detail' }, h(Button, { type: 'button', variant: 'ghost', onClick: () => onOpen(record) }, 'Open record')),
      );
    })),
  );
}

function MeasurementWorkspace({ surfaceInput, host }) {
  const [observations, setObservations] = useState({ records: [], complete: false, loading: true, error: '' });
  const [forecasts, setForecasts] = useState({ records: [], complete: false, loading: true, error: '' });
  const [billing, setBilling] = useState({ records: [], complete: false, loading: true, error: '' });
  const [provider, setProvider] = useState('');
  const [operation, setOperation] = useState('');
  const [scope, setScope] = useState('');
  const [view, setView] = useState('overview');
  const [selected, setSelected] = useState(null);
  const [refreshKey, setRefreshKey] = useState(() => crypto.randomUUID());
  const [pricing, setPricing] = useState({ rules: [], loading: false, error: '', result: '' });
  const [pricingSaveKey, setPricingSaveKey] = useState(() => crypto.randomUUID());
  const [pricingRule, setPricingRule] = useState({ effective_at: '', markup_percent: '', resource_id: '', plan_id: '', client_id: '' });
  const [pricingEdit, setPricingEdit] = useState(null);

  useEffect(() => {
    let live = true;
    const load = async (name, setter) => {
      try {
        const result = await readAll(host, name, refreshKey);
        if (live) setter({ ...result, loading: false, error: '' });
      } catch (error) {
        if (live) setter({ records: [], complete: false, loading: false, error: String(error?.message ?? error) });
      }
    };
    void Promise.all([
      load('read-observations', setObservations),
      load('read-forecasts', setForecasts),
      load('read-billing', setBilling),
    ]);
    return () => { live = false; };
  }, [host, surfaceInput?.generation, refreshKey]);

  const groups = useMemo(() => aggregate(observations.records, { groupBy: SUMMARY_DIMS }), [observations.records]);
  const filtered = useMemo(() => sorted(observations.records).filter(record => {
    const row = rowValue(record);
    return (!provider || String(row.provider ?? '').toLowerCase().includes(provider.toLowerCase()))
      && (!operation || String(row.operation ?? '').toLowerCase().includes(operation.toLowerCase()))
      && (!scope || row.scope === scope);
  }), [observations.records, provider, operation, scope]);
  const unknown = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'unknown' ? group.count : 0), 0);
  const partial = groups.reduce((sum, group) => sum + group.partial_count, 0);
  const assumed = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'assumed' ? group.count : 0), 0);
  const measured = groups.reduce((sum, group) => sum + (group.dimensions.scope === 'measured' ? group.count : 0), 0);
  const activeCount = groups.reduce((sum, group) => sum + group.count, 0);
  const retryUnknown = groups.reduce((sum, group) => sum + group.retry_unknown_count, 0);
  const errorUnknown = groups.reduce((sum, group) => sum + group.error_unknown_count, 0);
  const incompleteForecasts = forecasts.records.filter(record => rowValue(record).completeness === 'incomplete').length;
  const incomplete = unknown > 0 || partial > 0 || incompleteForecasts > 0 || observations.records.length === 0 || !observations.complete;
  const columns = [
    ['provider', 'Provider'], ['operation', 'Operation'], ['metric', 'Metric'], ['unit', 'Unit'], ['currency', 'Currency'],
    ['value', 'Value'], ['scope', 'Evidence'], ['evidence_kind', 'Evidence source'], ['source_revision', 'Source revision'], ['run_id', 'Run'], ['observed_at', 'Observed'],
  ];
  const showObservations = view === 'observations' || view === 'provider-operation';
  const detail = selected ? rowValue(selected) : null;
  const runPricing = async (action, rule = {}, expected_version) => {
    setPricing(current => ({ ...current, loading: true, error: '', result: '' }));
    const request_key = action === 'save' ? `measurement-workspace:pricing:save:${pricingSaveKey}` : `measurement-workspace:pricing:list:${crypto.randomUUID()}`;
    try {
      const raw = await host.call('manage-pricing', { request_key, action, rule, ...(expected_version === undefined ? {} : { expected_version }) });
      const result = raw?.structuredContent ?? raw?.result ?? raw;
      if (result?.error) throw new Error(String(result.error));
      const rules = Array.isArray(result?.rules) ? result.rules : Array.isArray(result?.result?.rules) ? result.result.rules : [];
      const savedRule = result?.rule ?? result?.result?.rule;
      setPricing(current => ({
        rules: action === 'save' ? (savedRule ? [...current.rules.filter(rule => rule.id !== savedRule.id), savedRule] : current.rules) : rules,
        loading: false, error: '', result: action === 'save' ? 'Save action completed. Load current pricing rules to confirm the account state.' : '',
      }));
      if (action === 'save') { setPricingEdit(null); setPricingSaveKey(crypto.randomUUID()); }
    } catch (error) {
      setPricing(current => ({ ...current, loading: false, error: String(error?.message ?? error) }));
    }
  };

  return h('main', { className: 'measurement-workspace' },
    h('header', null,
      h('h1', null, 'Cost measurements'),
      h('p', null, 'Usage, forecasts, and provider billing, with each unit and evidence scope kept intact.'),
    ),
    h('nav', { 'aria-label': 'Cost measurement views' }, ...[
      ['overview', 'Overview'], ['observations', 'Run history'], ['provider-operation', 'Provider drilldown'], ['forecasts', 'Forecasts'], ['billing', 'Billing'], ['pricing', 'Pricing inputs'],
    ].map(([id, label]) => h(Button, { key: id, type: 'button', variant: view === id ? 'default' : 'outline', onClick: () => setView(id) }, label))),
    incomplete ? h(Card, { role: 'status' }, h('strong', null, 'Coverage is incomplete'), h('p', null,
      observations.records.length === 0 ? 'No observations have arrived; provider and operation costs remain unknown, not zero. '
        : unknown ? `${unknown} observation rows are explicitly unknown. ` : '',
      partial ? `${partial} observation rows report partial coverage. ` : '',
      incompleteForecasts ? `${incompleteForecasts} forecast versions are incomplete. ` : '',
      !observations.complete ? 'The read reached its page limit; remaining rows are not counted as zero.' : 'Unknown values remain null and are not counted as zero.'),
      h('p', null, 'Freshness is unknown until an expected measurement cadence is stored.')) : null,
    observations.error || forecasts.error || billing.error ? h(Card, { role: 'alert' },
      h('strong', null, 'Some history could not be read'),
      h('p', null, observations.error || forecasts.error || billing.error)) : null,
    h('section', { 'aria-label': 'Coverage summary' },
      h(SummaryCard, { label: 'Measured observations', value: observations.loading ? 'Loading' : measured, note: 'Source-qualified values' }),
      h(SummaryCard, { label: 'Assumed observations', value: observations.loading ? 'Loading' : assumed, note: 'Kept separate from measured' }),
      h(SummaryCard, { label: 'Unknown observations', value: observations.loading ? 'Loading' : unknown, note: 'Unknown is not zero' }),
      h(SummaryCard, { label: 'Partial observation rows', value: observations.loading ? 'Loading' : partial, note: 'Partial coverage remains visible' }),
      h(SummaryCard, { label: 'Forecast versions', value: forecasts.loading ? 'Loading' : forecasts.records.length, note: 'Predicted, separate from billing' }),
      h(SummaryCard, { label: 'Billing records', value: billing.loading ? 'Loading' : billing.records.length, note: 'Provider billed amounts' }),
      h(SummaryCard, { label: 'Retry coverage', value: observations.loading ? 'Loading' : `${retryUnknown} observations unknown`, note: 'Counts stay within their metric and run; repeated metadata is not added across metrics' }),
      h(SummaryCard, { label: 'Error coverage', value: observations.loading ? 'Loading' : `${errorUnknown} observations unknown`, note: 'Open each run and metric for its recorded count' }),
    ),
    view === 'overview' ? h('section', null,
      h('h2', null, 'Granular totals'),
      h('p', null, 'Groups retain provider, operation, metric semantics, unit, currency, scenario, source revision, run, and time window.'),
      h(DataTable, { columns: [['provider', 'Provider'], ['operation', 'Operation'], ['metric', 'Metric'], ['unit', 'Unit'], ['currency', 'Currency'], ['value', 'Value'], ['value_scope', 'Evidence'], ['completeness', 'Coverage'], ['count', 'Rows'], ['retry_count', 'Retries'], ['error_count', 'Errors'], ['source_revision', 'Revision'], ['run_id', 'Run'], ['window_start', 'Window starts'], ['window_end', 'Window ends']], rows: groups.map((group, i) => ({ id: `group-${i}`, value: { ...group.dimensions, value: group.value, value_scope: group.value_scope, completeness: group.completeness, count: group.count, retry_count: group.retry_count, error_count: group.error_count } })), onOpen: setSelected }),
      h('h2', null, 'Source coverage'),
      h('p', null, activeCount ? `Showing ${activeCount} active observation rows from ${observations.records.length} stored rows; corrections remain in history.` : 'No observations have arrived yet; all provider and operation coverage is unknown.'),
    ) : null,
    showObservations ? h('section', null,
      h('h2', null, view === 'observations' ? 'Historical runs' : 'Provider and operation'),
      h('div', null,
        h('label', null, 'Provider', h(Input, { value: provider, onChange: event => setProvider(event.target.value), 'aria-label': 'Filter by provider' })),
        h('label', null, 'Operation', h(Input, { value: operation, onChange: event => setOperation(event.target.value), 'aria-label': 'Filter by operation' })),
        h('label', null, 'Evidence scope', h('select', { value: scope, onChange: event => setScope(event.target.value), 'aria-label': 'Filter by evidence scope' },
          h('option', { value: '' }, 'All scopes'), ...['measured', 'assumed', 'unknown'].map(value => h('option', { key: value, value }, value)))),
        h(Button, { type: 'button', variant: 'outline', onClick: () => setRefreshKey(crypto.randomUUID()) }, 'Refresh records'),
      ),
      observations.loading ? h('p', { role: 'status' }, 'Reading saved observations…') : null,
      h(DataTable, { columns, rows: filtered, onOpen: setSelected }),
      !observations.complete ? h('p', null, 'This view reached its safe read bound. Remaining rows are not included in these totals.') : null,
    ) : null,
    view === 'forecasts' ? h('section', null,
      h('h2', null, 'Forecast history'),
      h('p', null, 'Each version keeps its source revision and component detail. Incomplete forecasts stay labeled incomplete.'),
      h(DataTable, { columns: [['forecast_id', 'Scenario'], ['version', 'Version'], ['source_revision', 'Source revision'], ['created_at', 'Created'], ['completeness', 'Coverage']], rows: forecasts.records, onOpen: setSelected }),
      h('h2', null, 'Forecast components'),
      h('p', null, 'Predicted components retain their own unit, currency, evidence scope, operation, metric, and value. They are not added across unlike units.'),
      h(DataTable, { columns: [['forecast_id', 'Scenario'], ['version', 'Version'], ['operation', 'Operation'], ['metric', 'Metric'], ['unit', 'Unit'], ['currency', 'Currency'], ['value', 'Value'], ['scope', 'Evidence'], ['completeness', 'Coverage'], ['source_revision', 'Source revision']], rows: forecasts.records.flatMap(record => {
        const forecast = rowValue(record);
        return (Array.isArray(forecast.components) ? forecast.components : []).map((component, index) => ({
          id: `${forecast.forecast_id}:v${forecast.version}:component:${index}`,
          value: { forecast_id: forecast.forecast_id, version: forecast.version, completeness: forecast.completeness, source_revision: forecast.source_revision, ...component },
        }));
      }), onOpen: setSelected }),
    ) : null,
    view === 'billing' ? h('section', null,
      h('h2', null, 'Provider billing'),
      h('p', null, 'Billed records remain separate from observations and forecasts. Amounts are not rolled into predicted totals.'),
      h(DataTable, { columns: [['billing_id', 'Billing record'], ['version', 'Version'], ['provider', 'Provider'], ['billing_period_start', 'Period starts'], ['billing_period_end', 'Period ends'], ['amount', 'Billed amount'], ['currency', 'Currency'], ['unit', 'Billed unit'], ['scope', 'Evidence'], ['observed_at', 'Observed'], ['source_revision', 'Source revision']], rows: billing.records, onOpen: setSelected }),
    ) : null,
    view === 'pricing' ? h('section', null,
      h('h2', null, 'Editable pricing inputs'),
      h('p', null, 'Pricing rules are managed by the existing pricing tool. Saving creates or updates a versioned assumption; it does not change purchased terms or rewrite a forecast.'),
      h(Button, { type: 'button', variant: 'outline', disabled: pricing.loading, onClick: () => void runPricing('list') }, pricing.loading ? 'Loading pricing rules…' : 'Load current pricing rules'),
      pricing.error ? h(Card, { role: 'alert' }, h('p', null, pricing.error)) : null,
      pricing.result ? h(Card, { role: 'status' }, h('p', null, pricing.result)) : null,
      h(DataTable, { columns: [['id', 'Rule'], ['effective_at', 'Effective'], ['ends_at', 'Ends'], ['markup_percent', 'Markup'], ['scope', 'Scope'], ['state', 'State']], rows: pricing.rules.map((rule, index) => ({ id: rule.id ?? `pricing-rule-${index}`, value: rule })), onOpen: setSelected }),
      h('h3', null, 'Add a pricing assumption'),
      h('form', { onSubmit: event => {
        event.preventDefault();
        const scopeValue = Object.fromEntries(Object.entries({ resource_id: pricingRule.resource_id, plan_id: pricingRule.plan_id, client_id: pricingRule.client_id }).filter(([, value]) => value.trim()));
        void runPricing('save', { ...(pricingEdit ? { id: pricingEdit.id } : {}), effective_at: pricingRule.effective_at, markup_percent: pricingRule.markup_percent, ...(Object.keys(scopeValue).length ? { scope: scopeValue } : {}) }, pricingEdit?.version);
      } },
        h('label', null, 'Effective at', h(Input, { type: 'datetime-local', value: pricingRule.effective_at, required: true, onChange: event => setPricingRule(current => ({ ...current, effective_at: event.target.value })) })),
        h('label', null, 'Markup percent', h(Input, { type: 'number', min: '0', step: '0.01', value: pricingRule.markup_percent, required: true, onChange: event => setPricingRule(current => ({ ...current, markup_percent: event.target.value })) })),
        h('label', null, 'Resource ID (optional)', h(Input, { value: pricingRule.resource_id, onChange: event => setPricingRule(current => ({ ...current, resource_id: event.target.value })) })),
        h('label', null, 'Plan ID (optional)', h(Input, { value: pricingRule.plan_id, onChange: event => setPricingRule(current => ({ ...current, plan_id: event.target.value })) })),
        h('label', null, 'Client ID (optional)', h(Input, { value: pricingRule.client_id, onChange: event => setPricingRule(current => ({ ...current, client_id: event.target.value })) })),
        h(Button, { type: 'submit', disabled: pricing.loading || !pricingRule.effective_at || !pricingRule.markup_percent }, pricing.loading ? 'Saving…' : pricingEdit ? 'Save new rule version' : 'Save pricing assumption'),
        pricingEdit ? h(Button, { type: 'button', variant: 'ghost', onClick: () => setPricingEdit(null) }, 'Cancel rule edit') : null,
      ),
    ) : null,
    detail ? h(Card, { 'aria-label': 'Selected record detail' },
      h('h2', null, 'Record detail'),
      h('dl', null, ...Object.entries(detail).flatMap(([key, value]) => [h('dt', { key: `${key}-label` }, key.replaceAll('_', ' ')), h('dd', { key }, valueCell(value))])),
      view === 'pricing' && pricing.rules.some(rule => rule.id === detail.id) ? h(Button, { type: 'button', variant: 'outline', onClick: () => {
        const rule = pricing.rules.find(candidate => candidate.id === detail.id);
        setPricingEdit({ id: rule.id, version: rule.version });
        setPricingRule({ effective_at: rule.effective_at ?? '', markup_percent: String(rule.markup_percent ?? ''), resource_id: rule.scope?.resource_id ?? '', plan_id: rule.scope?.plan_id ?? '', client_id: rule.scope?.client_id ?? '' });
      } }, 'Edit pricing inputs') : null,
      h(Button, { type: 'button', variant: 'outline', onClick: () => setSelected(null) }, 'Close detail'),
    ) : null,
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(MeasurementWorkspace, { surfaceInput, host }));
}
