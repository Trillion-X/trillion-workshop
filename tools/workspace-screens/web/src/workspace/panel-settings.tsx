// src/workspace/panel-settings.tsx
//
// PURPOSE
//   The menu bar item's settings in the Mac menu bar panel's own page (src/workspace/alone-page.tsx): show the item, how
//   far ahead a meeting is counted down to, how long its title may be and the app icon (F-0994). The Mac app only
//   keeps the values and applies them; the choice is made here, in the web page, so the panel draws no menu of its own
//   (macos/App/MenuBarPanel.swift invariant 1).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rows show nothing until a host answers (panel-settings.mjs): in a browser, or a host that does not know the
//      message, there are none.
//   2. Every control is a shared part (parts/ui Card, Container, Text, Switch, Select, Slider); this file writes no markup
//      of its own. A row's words are DATA (src/alone-page.json words.settings, by row id); a row with no words is not shown,
//      so a machine id never reaches the person.
//   3. A row shows what the host answered; a change sends the value and waits for the host's new answer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Card, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Slider, Switch, Text } from '../../parts/ui';
import settings from '../alone-page.json';
import { askPanelSettings, panelSettingsState, setPanelSetting } from './panel-settings.mjs';

export const PANEL_SETTINGS_EVENT = 'trillion-panel-settings';

type State = NonNullable<ReturnType<typeof panelSettingsState>>;
type Row = State['rows'][number];
type Words = { title: string; note?: string; unit?: string };
const wordsOf = (id: string) => (settings.words.settings as Record<string, Words | undefined>)[id];

function Control({ row, title, unit, set }: { row: Row; title: string; unit: string; set: (value: boolean | string | number) => void }) {
  if (row.kind === 'switch') return <Switch label={title} checked={row.value === true} onCheckedChange={set} />;
  if (row.kind === 'range') {
    return <Slider label={title} value={Number(row.value)} min={row.least} max={row.most} step={row.step} unit={unit} onValueChange={set} />;
  }
  const shown = row.choices?.find(choice => choice.id === row.value)?.title ?? '';
  return (
    <Select value={String(row.value)} onValueChange={value => { if (typeof value === 'string') set(value); }}>
      <SelectTrigger aria-label={title}><SelectValue>{shown}</SelectValue></SelectTrigger>
      <SelectPopup>{row.choices?.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.title}</SelectItem>)}</SelectPopup>
    </Select>
  );
}

export function PanelSettings({ tell }: { tell: (message: ReturnType<typeof askPanelSettings> | ReturnType<typeof setPanelSetting>) => void }) {
  const [state, setState] = React.useState<State | null>(null);
  React.useEffect(() => {
    const take = (event: Event) => setState(panelSettingsState((event as CustomEvent).detail));
    window.addEventListener(PANEL_SETTINGS_EVENT, take);
    tell(askPanelSettings());
    return () => window.removeEventListener(PANEL_SETTINGS_EVENT, take);
  }, [tell]);
  const rows = state?.rows.filter(row => wordsOf(row.id)) ?? [];
  if (rows.length === 0) return null;
  return (
    <Card variant="nested" padding="md" aria-label={settings.words.menubar} data-panel-settings="">
      <Container layout="vertical" gap="sm">
        <Text as="p" variant="body">{settings.words.menubar}</Text>
        {rows.map(row => {
          const words = wordsOf(row.id) as Words;
          return (
            <Container key={row.id} layout="vertical" gap="xs" data-panel-setting={row.id}>
              {row.kind === 'range' ? null : <Text as="p" variant="body">{words.title}</Text>}
              {words.note ? <Text as="p" variant="caption" color="muted">{words.note}</Text> : null}
              <Control row={row} title={words.title} unit={words.unit ?? ''} set={value => tell(setPanelSetting(row.id, value))} />
            </Container>
          );
        })}
      </Container>
    </Card>
  );
}
