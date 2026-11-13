// src/workspace/task-tray.tsx
//
// PURPOSE
//   The controls around the task tray beside the Calendar: the strip of lists above it with a count on each and a way to add
//   one, the Display menu (group by, sort by, which tasks to show), and the bar that offers actions on the tasks marked
//   together. Each is drawn from the tray DATA (calendar-task-tray.json); what each choice means for the tasks is
//   src/calendar-task-views.mjs, and what the actions do is task-verbs.tsx.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word and every choice is a row of the tray DATA; every control is a shared ui part.
//   2. Nothing is kept here but what a control is showing (an open popover, the words being typed): which list is chosen and
//      the Display choices belong to the screen, which keeps them as the person's own.

import React from 'react';
import { Button, ColorDot, Container, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Tabs, TabsList, TabsTrigger, Text } from '../../parts/ui';
import { BulkSelectBar } from '../../parts/ui/show/bulk-select-bar';
import { Popover, PopoverPopup, PopoverTrigger } from '../../parts/ui/show/coss/ui/popover';
import { NamedIcon } from '../../parts/ui/show/icon';
import taskData from '../calendar-tasks.json';
import tray from './calendar-task-tray.json';
import screenData from './shared-calendar.json';
import { fill } from './calendar-screen-core';
import type { TrayDisplay } from '../calendar-task-views.mjs';

const words = tray.words;
const colorOf = (id: string | null | undefined) => (taskData.list_colors as { id: string; color: string }[]).find(row => row.id === id)?.color;

export type TaskTab = { id: string; label: string; count: number; builtin: boolean; icon?: string; color?: string | null };

/** The lists strip: every list with its count, a way to add one, and the key-driven switcher. */
export function TaskListTabs({ tabs, more = false, active, onChange, onCreate, switcherOpen, onSwitcherOpenChange }: {
  tabs: TaskTab[]; more?: boolean; active: string; onChange: (id: string) => void; onCreate: (name: string) => Promise<boolean>;
  switcherOpen: boolean; onSwitcherOpenChange: (open: boolean) => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const create = async () => {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    try { if (await onCreate(title)) { setName(''); setAdding(false); } } finally { setBusy(false); }
  };
  return <Container layout="horizontal" gap="xs" alignItems="center" className="calendar-task-tabs" data-calendar-task-tabs>
    <Tabs value={active} onValueChange={onChange} className="calendar-task-tabs-list">
      <TabsList moreLabel={words.switch_list} moreOpen={switcherOpen} onMoreOpenChange={onSwitcherOpenChange}>
        {tabs.map(tab => {
          const color = colorOf(tab.color);
          return <TabsTrigger key={tab.id} value={tab.id} data-task-list-tab={tab.id}>
            {color ? <ColorDot color={color} size="sm" data-list-color={tab.color ?? undefined} /> : null}
            <Text as="span" variant="caption" className="calendar-task-tab-label">{tab.label}</Text>
            <Text as="span" variant="caption" color="muted" className="calendar-task-tab-count">{more ? `${tab.count}+` : tab.count}</Text>
          </TabsTrigger>;
        })}
      </TabsList>
    </Tabs>
    <Popover open={adding} onOpenChange={setAdding}>
      <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label={words.add_list} title={words.add_list} />}><NamedIcon name="Plus" size="xs" aria-hidden /></PopoverTrigger>
      <PopoverPopup align="end" portalProps={{ className: 'coss-ui', keepMounted: true }}>
        <Container layout="vertical" gap="sm" padding="sm" data-task-list-add>
          <Input label={words.add_list_name} aria-label={words.add_list_name} value={name} disabled={busy} autoComplete="off"
            onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create(); } }} />
          <Button size="sm" variant="primary" disabled={!name.trim() || busy} onClick={() => create()}>{words.add_list_create}</Button>
        </Container>
      </PopoverPopup>
    </Popover>
  </Container>;
}

export type TaskDisplay = TrayDisplay;

/** The Display menu: how the tray groups and sorts, and which tasks it shows. `children` are the menu's other entries. */
export function TaskDisplayMenu({ display, onChange, children }: { display: TaskDisplay; onChange: (next: TaskDisplay) => void; children?: React.ReactNode }) {
  const copy = tray.display.words;
  return <Popover>
    <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label={screenData.words.display_options} title={screenData.words.display_options} />}>
      <NamedIcon name={screenData.task_options_icon} size="xs" aria-hidden />
    </PopoverTrigger>
    <PopoverPopup align="end" className="calendar-task-display-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
      <Container layout="vertical" gap="sm" padding="sm" data-task-display-menu>
        <Text variant="caption" weight="semibold">{copy.heading}</Text>
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">{copy.group_by}</Text>
          <Select modal={false} items={tray.display.group_by.map(row => ({ value: row.id, label: row.label }))} value={display.group_by} onValueChange={value => { if (typeof value === 'string') onChange({ ...display, group_by: value, group_levels: undefined }); }}>
            <SelectTrigger aria-label={copy.group_by}><SelectValue /></SelectTrigger>
            <SelectPopup portalProps={{ className: 'coss-ui', keepMounted: true }}>{tray.display.group_by.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">{copy.sort_by}</Text>
          <Select modal={false} items={tray.display.sort_by.map(row => ({ value: row.id, label: row.label }))} value={display.sort_by} onValueChange={value => { if (typeof value === 'string') onChange({ ...display, sort_by: value }); }}>
            <SelectTrigger aria-label={copy.sort_by}><SelectValue /></SelectTrigger>
            <SelectPopup portalProps={{ className: 'coss-ui', keepMounted: true }}>{tray.display.sort_by.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">{copy.view}</Text>
          {tray.display.view.map(row => <Container key={row.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Text variant="body-sm">{row.label}</Text>
            <Switch size="sm" label={row.label} checked={display[row.id] === true} onCheckedChange={checked => onChange({ ...display, [row.id]: checked })} />
          </Container>)}
        </Container>
        {children}
      </Container>
    </PopoverPopup>
  </Popover>;
}

/** Actions on the tasks marked together (Command- or Shift-press, or Shift with the arrow keys). */
export function TaskMarkedBar({ count, onClear, onDone, onMove, onDelete, disabled }: { count: number; onClear: () => void; onDone: () => void; onMove: () => void; onDelete: () => void; disabled: boolean }) {
  return <BulkSelectBar selectedCount={count} onClearAll={onClear} clearDisabled={disabled}
    actions={[
      { label: words.marked_done, onClick: onDone, disabled },
      { label: words.marked_move, onClick: onMove, disabled },
      { label: words.marked_delete, onClick: onDelete, disabled, variant: 'danger' as const },
    ]}
    words={{ selected: total => fill(words.marked, { count: total }), clear: words.marked_clear, more: screenData.words.calendar_selection_more, actions: screenData.words.calendar_selection_actions }}
    className="min-w-0 flex-wrap" />;
}
