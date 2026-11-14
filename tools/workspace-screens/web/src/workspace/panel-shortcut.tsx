// src/workspace/panel-shortcut.tsx
//
// PURPOSE
//   The "Show this panel with a shortcut" setting row in the Mac menu bar panel's own page (src/workspace/alone-page.tsx).
//   The Mac app only registers the key; the choice is made here, in the web page, so the panel draws no menu of its own
//   (macos/App/MenuBarPanel.swift invariant 1). Off is the default.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The row shows nothing until a host answers (panel-shortcut.mjs): in a browser, or a host that does not know the
//      message, there is no row.
//   2. Every control is a shared part (parts/ui Card, Container, Text, Select); this file writes no markup of its own
//      and every word is DATA (src/alone-page.json words).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Card, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text } from '../../parts/ui';
import settings from '../alone-page.json';
import { askShortcut, pickShortcut, shortcutState } from './panel-shortcut.mjs';

type State = NonNullable<ReturnType<typeof shortcutState>>;
export const PANEL_SHORTCUT_EVENT = 'trillion-panel-shortcut';
const OFF = '';

export function PanelShortcut({ tell }: { tell: (message: ReturnType<typeof askShortcut>) => void }) {
  const [state, setState] = React.useState<State | null>(null);
  React.useEffect(() => {
    const take = (event: Event) => setState(shortcutState((event as CustomEvent).detail));
    window.addEventListener(PANEL_SHORTCUT_EVENT, take);
    tell(askShortcut());
    return () => window.removeEventListener(PANEL_SHORTCUT_EVENT, take);
  }, [tell]);
  if (!state) return null;
  const shown = state.choices.find(row => row.id === state.pick)?.title ?? settings.words.shortcut_off;
  return (
    <Card variant="nested" padding="md" aria-label={settings.words.shortcut} data-panel-shortcut="">
      <Container layout="vertical" gap="sm">
        <Container layout="vertical" gap="xs">
          <Text as="p" variant="body">{settings.words.shortcut}</Text>
          <Text as="p" variant="caption" color="muted">{settings.words.shortcut_note}</Text>
        </Container>
        <Select value={state.pick ?? OFF} onValueChange={value => tell(pickShortcut(typeof value === 'string' && value !== OFF ? value : null))}>
          <SelectTrigger aria-label={settings.words.shortcut}><SelectValue>{shown}</SelectValue></SelectTrigger>
          <SelectPopup>
            <SelectItem value={OFF}>{settings.words.shortcut_off}</SelectItem>
            {state.choices.map(row => <SelectItem key={row.id} value={row.id}>{row.title}</SelectItem>)}
          </SelectPopup>
        </Select>
      </Container>
    </Card>
  );
}
