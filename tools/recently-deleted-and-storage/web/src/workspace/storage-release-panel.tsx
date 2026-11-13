// src/workspace/storage-release-panel.tsx
//
// PURPOSE
//   The top of Recently Deleted: how much storage the person's files use, how much of it waits in Recently Deleted and
//   Archived, how storage falls over the next days as that leaves, what was already given back, and the person's own
//   release rules ("Give back what was in /Card after 1 day", "Give back the oldest while storage is above 500 GB").
//   It reads and writes GET /work/api/namespace/storage and POST /work/api/namespace/release-rules
//   (src/namespace-release-rules.mjs), the same answer an AI reads with read_storage and changes with set_release_rules.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a fact, an order, a number of days or a size: the facts a rule can name, the orders and the
//      choices offered all arrive in the store's answer (namespace-byte-release.json).
//   2. Which items a rule covers is the formula engine's answer, edited with the shared rule filter; this file never
//      decides it.
//   3. Every element is a shared part: Container, Text, Button, Switch, ActionMenu, RuleFilterChips, UsageMeter,
//      StatStrip, Chart.
//   4. A change is saved as the whole list at once and redrawn from the store's answer, so the screen never keeps a
//      rule the store refused.

import React, { useMemo, useState } from 'react';
import { Button, Chart, chartOfPoints, Container, StatStrip, Switch, Text, UsageMeter } from '../../parts/ui';
import { ActionMenu, type ActionMenuItem } from '../../parts/ui/show/action-menu';
import { RuleFilterChips, type RuleFacet, type RuleFieldView, type RuleGroup, type RuleOperatorData } from '../../parts/ui/show/rule-filter';
import { formatBytes } from '../../parts/ui/show/notifications/notification-center';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import operators from '../../../../formula-engine/rules/rule-operators.json';
import { readJson } from './api';

export type ReleaseRule = { id: string; label: string; on: boolean; when: RuleGroup | null; after_days: number | null; storage_above_bytes: number | null; order: string };
type Fact = { id: string; label: string; kind: string; icon?: string };
type Day = { day: string; bytes: number; items?: number; objects?: number };
export type Storage = {
  kept: { bytes: number; files: number };
  waiting: { bytes: number; items: number };
  leaving: Day[];
  items: { id: string; facts: Record<string, string | number>; leaves_at: string | null; because: string | null; when_storage_above: number | null; byte_length: number }[];
  given_back: { released: { objects: number; bytes: number }; waiting: { objects: number; bytes: number } };
  given_back_by_day: Day[];
  rules: ReleaseRule[];
  item_facts: Fact[];
  orders: { id: string; label: string }[];
  choices: { after_days: number[]; storage_above_bytes: number[] };
  next_pass_at: string | null;
};

const EMPTY: RuleGroup = { kind: 'group', combinator: 'and', negate: false, rules: [] };
const dayWords = (days: number) => (days === 0 ? 'as soon as it is deleted' : days === 1 ? '1 day after it is deleted' : `${days} days after it is deleted`);

/** What exists for each fact, so a rule's value menus list the real folders and kinds with their counts. */
function facetsOf(storage: Storage): Record<string, RuleFacet> {
  const facets: Record<string, RuleFacet> = {};
  for (const fact of storage.item_facts) {
    const values = storage.items.map(item => item.facts[fact.id]);
    if (fact.kind === 'choice') {
      const counts = new Map<string, number>();
      for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
      facets[fact.id] = { options: [...counts].map(([value, count]) => ({ value, count })) };
    } else if (values.length && typeof values[0] === 'number') {
      facets[fact.id] = { min: Math.min(...(values as number[])), max: Math.max(...(values as number[])) };
    }
  }
  return facets;
}

function RuleCard({ rule, storage, fields, facets, onChange, onRemove }: {
  rule: ReleaseRule; storage: Storage; fields: RuleFieldView[]; facets: Record<string, RuleFacet>;
  onChange: (next: ReleaseRule) => void; onRemove: () => void;
}) {
  const [building, setBuilding] = useState(false);
  const covered = storage.items.filter(item => item.because === rule.id);
  const timing: ActionMenuItem[] = [
    { id: 'after', label: 'After a number of days', icon: 'Hourglass', items: storage.choices.after_days.map(days => ({ id: `after:${days}`, label: dayWords(days), icon: 'Clock', checked: rule.after_days === days && rule.storage_above_bytes === null })) },
    { id: 'storage', label: 'While storage is above', icon: 'HardDrive', items: storage.choices.storage_above_bytes.map(bytes => ({ id: `storage:${bytes}`, label: formatBytes(bytes), icon: 'Gauge', checked: rule.storage_above_bytes === bytes })) },
    { id: 'order', label: 'Which go first', icon: 'ArrowDownWideNarrow', items: storage.orders.map(order => ({ id: `order:${order.id}`, label: order.label, icon: 'ListOrdered', checked: rule.order === order.id })) },
  ];
  const pick = (id: string) => {
    const at = id.indexOf(':');
    const what = id.slice(0, at), value = id.slice(at + 1);
    if (what === 'after') onChange({ ...rule, after_days: Number(value), storage_above_bytes: null });
    if (what === 'storage') onChange({ ...rule, storage_above_bytes: Number(value), after_days: null });
    if (what === 'order') onChange({ ...rule, order: value });
  };
  const orderWords = storage.orders.find(order => order.id === rule.order)?.label.toLowerCase() ?? '';
  const when = rule.storage_above_bytes !== null ? `while storage is above ${formatBytes(rule.storage_above_bytes)}, ${orderWords}` : dayWords(rule.after_days ?? 0);
  const coveredBytes = covered.reduce((sum, item) => sum + item.byte_length, 0);
  return (
    <Container layout="vertical" gap="sm" padding="md" border="all" rounded="lg" background="secondary" data-storage-rule={rule.id} data-on={rule.on}>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <Text variant="body" weight="semibold">Give back</Text>
        {rule.when
          ? <RuleFilterChips fields={fields} operators={operators as unknown as RuleOperatorData} value={rule.when} facets={facets}
              onChange={next => onChange({ ...rule, when: next.rules.length ? next : null })} builderOpen={building} onBuilderOpenChange={setBuilding} />
          : <Button size="sm" variant="outline" onClick={() => { onChange({ ...rule, when: EMPTY }); setBuilding(true); }}>everything deleted</Button>}
        <ActionMenu label="When" items={timing} onAction={pick} iconTrigger={false} triggerContent={when} />
        <Container layout="horizontal" gap="sm" alignItems="center" flex={1} justifyContent="end">
          <Switch checked={rule.on} onCheckedChange={on => onChange({ ...rule, on })} label={rule.on ? 'Rule on' : 'Rule off'} size="sm" />
          <ActionMenu label="Rule" items={[{ id: 'remove', label: 'Remove rule', icon: 'Trash2', tone: 'destructive', confirm: 'Remove this rule' }]} onAction={onRemove} />
        </Container>
      </Container>
      <Text variant="body-xs" color="muted">
        {covered.length ? `Gives back ${covered.length} deleted ${covered.length === 1 ? 'item' : 'items'} sooner, ${formatBytes(coveredBytes)}.` : 'Nothing deleted now is given back sooner by this rule.'}
      </Text>
    </Container>
  );
}

export function StoragePanel({ initial }: { initial: Storage }) {
  const [storage, setStorage] = useState(initial);
  const fields: RuleFieldView[] = useMemo(() => storage.item_facts.map(fact => ({ id: fact.id, label: fact.label, kind: fact.kind, icon: fact.icon })), [storage.item_facts]);
  const facets = useMemo(() => facetsOf(storage), [storage]);
  const save = (rules: ReleaseRule[]) => {
    const before = storage;
    setStorage(current => ({ ...current, rules }));
    void readJson<Storage>('/work/api/namespace/release-rules', { method: 'POST', body: JSON.stringify({ rules }) })
      .then(setStorage, error => { notify('The rule could not be kept', { kind: 'error', detail: errorWords(error) }); setStorage(before); });
  };
  const leavingSoon = storage.leaving.reduce((sum, day) => sum + day.bytes, 0);
  const soon = Math.min(leavingSoon, storage.waiting.bytes);
  const yours = Math.max(0, storage.kept.bytes - storage.waiting.bytes);
  // Storage over the coming days, falling as what waits leaves.
  let left = storage.kept.bytes;
  const points = storage.leaving.map(day => { left -= day.bytes; return { value: Math.max(0, left), t: Date.parse(day.day) }; });
  const addRule = () => save([...storage.rules, { id: `rule-${Date.now().toString(36)}`, label: '', on: true, when: null, after_days: storage.choices.after_days[1] ?? storage.choices.after_days[0] ?? 0, storage_above_bytes: null, order: storage.orders[0]?.id ?? '' }]);
  return (
    <Container layout="vertical" gap="lg" padding="md" data-storage-panel>
      <Container layout="vertical" gap="xs">
        <Text variant="heading" weight="semibold">{formatBytes(storage.kept.bytes)} of files kept</Text>
        <Text variant="body" color="muted">
          {storage.waiting.items ? `${formatBytes(storage.waiting.bytes)} of it is deleted and waiting to be given back.` : 'Nothing deleted is waiting.'}
        </Text>
      </Container>
      <UsageMeter label="Storage" total={storage.kept.bytes} segments={[
        { id: 'kept', label: 'Your files', amount: yours, words: formatBytes(yours), tone: 'used' },
        { id: 'soon', label: `Leaving in ${storage.leaving.length} days`, amount: soon, words: formatBytes(soon), tone: '3' },
        { id: 'later', label: 'Deleted, leaving later', amount: storage.waiting.bytes - soon, words: formatBytes(storage.waiting.bytes - soon), tone: '6' },
      ]} />
      <StatStrip stats={[
        { label: 'Kept', value: formatBytes(storage.kept.bytes) },
        { label: 'Waiting', value: formatBytes(storage.waiting.bytes) },
        { label: `Next ${storage.leaving.length} days`, value: formatBytes(leavingSoon) },
        { label: 'Given back', value: formatBytes(storage.given_back.released.bytes) },
      ]} />
      <Container layout="vertical" gap="xs">
        <Text variant="label" color="muted">Storage over the next {storage.leaving.length} days</Text>
        <Chart mark="area" height={200} label="Storage over the next days" data={chartOfPoints(points, { label: 'Storage', value_kind: 'bytes', tone: 'good' })}
          empty={{ title: 'Nothing leaves soon', description: 'Deleted files give back their storage when their time ends.' }} />
      </Container>
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text variant="label" color="muted">When storage is given back</Text>
          <Button size="sm" variant="outline" onClick={addRule}>Add a rule</Button>
        </Container>
        {storage.rules.length === 0 && <Text variant="body-xs" color="muted">Everything deleted waits its full keep-for time. Add a rule to give storage back sooner for a folder, a kind of file, big files, or when storage passes a size.</Text>}
        {storage.rules.map(rule => (
          <RuleCard key={rule.id} rule={rule} storage={storage} fields={fields} facets={facets}
            onChange={next => save(storage.rules.map(row => (row.id === rule.id ? next : row)))}
            onRemove={() => save(storage.rules.filter(row => row.id !== rule.id))} />
        ))}
      </Container>
    </Container>
  );
}
