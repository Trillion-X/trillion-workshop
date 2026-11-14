// src/workspace/panel-setup.tsx
//
// PURPOSE
//   The "Set up this Mac" section of the Mac menu bar panel's own page (src/workspace/alone-page.tsx): the placement steps
//   with done and undo (F-0061) and the permission switches with "open guide" (F-0074). The Mac app only does the work and
//   answers; the choice is made here, in the web page, so the panel draws no menu of its own (macos/App/MenuBarPanel.swift
//   invariant 1).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A section shows nothing until the host answers it (panel-setup.mjs): in a browser, or a host that does not know the
//      message, there is none.
//   2. Every control is a shared part (parts/ui Card, Container, Text, Button); this file writes no markup of its own and every
//      word is DATA (src/alone-page.json words) or the host's own (a step's title).
//   3. A step reads done only when the host said so; a click sends the change and waits for the host's new answer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Button, Card, Container, Text } from '../../parts/ui';
import settings from '../alone-page.json';
import { askPermissions, askPlacement, changePlacement, openPermissionGuide, permissionsState, placementState } from './panel-setup.mjs';

export const PANEL_PLACEMENT_EVENT = 'trillion-panel-placement';
export const PANEL_PERMISSIONS_EVENT = 'trillion-panel-permissions';

type Tell = (message: ReturnType<typeof askPlacement> | ReturnType<typeof changePlacement> | ReturnType<typeof askPermissions> | ReturnType<typeof openPermissionGuide>) => void;

function useHostAnswer<T>(event: string, read: (answer: unknown) => T | null, ask: () => void): T | null {
  const [state, setState] = React.useState<T | null>(null);
  React.useEffect(() => {
    const take = (e: Event) => setState(read((e as CustomEvent).detail));
    window.addEventListener(event, take);
    ask();
    return () => window.removeEventListener(event, take);
  }, [event, read, ask]);
  return state;
}

export function PanelSetup({ tell }: { tell: Tell }) {
  const placement = useHostAnswer(PANEL_PLACEMENT_EVENT, placementState, React.useCallback(() => tell(askPlacement()), [tell]));
  const permissions = useHostAnswer(PANEL_PERMISSIONS_EVENT, permissionsState, React.useCallback(() => tell(askPermissions()), [tell]));
  if (!placement && !permissions) return null;
  return (
    <Card variant="nested" padding="md" aria-label={settings.words.setup} data-panel-setup="">
      <Container layout="vertical" gap="sm">
        {placement && (
          <Container layout="vertical" gap="xs">
            <Text as="p" variant="body">{settings.words.setup}</Text>
            <Text as="p" variant="caption" color="muted">{settings.words.setup_note}</Text>
            {placement.steps.map(step => (
              <Container key={step.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" data-placement-step={step.id}>
                <Text as="span" variant="body">{step.done ? step.done_title : step.title}</Text>
                <Button variant="ghost" size="sm" onClick={() => tell(changePlacement(step.id, step.done))}>{step.done ? settings.words.undo : settings.words.apply}</Button>
              </Container>
            ))}
          </Container>
        )}
        {permissions && (
          <Container layout="vertical" gap="xs">
            <Text as="p" variant="body">{settings.words.permissions}</Text>
            <Text as="p" variant="caption" color="muted">{settings.words.permissions_note}</Text>
            {permissions.switches.map(row => (
              <Container key={row.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" data-permission-switch={row.id}>
                <Text as="span" variant="body">{row.title}</Text>
                <Button variant="ghost" size="sm" onClick={() => tell(openPermissionGuide(row.id))}>{settings.words.open_guide}</Button>
              </Container>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
}
