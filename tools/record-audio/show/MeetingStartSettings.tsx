import * as React from 'react';
import { ChoiceTiles, Container, Switch, Text } from '../../ui';
import { ArrangedContents } from '../../screen-arrangement/show/ArrangedContents';
import settings from 'trillion-workshop/tools/record-voice-and-meetings/read-data/meeting-start-settings.json';

export type MeetingStartMode = 'automatic' | 'through-app' | 'reminder' | 'manual';
export type MeetingStartApp = { id: string; label: string; active?: boolean };
export type MeetingAppObservationStatus = 'inactive' | 'observing' | 'inspected' | 'unavailable';

function validAppId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id);
}

export function MeetingStartSettings({ mode, onChange, apps, allowedApps, blockedApps, onAppEnabledChange, observationStatus }: {
  mode: MeetingStartMode;
  onChange: (mode: MeetingStartMode) => void;
  /** Dynamically observed host applications; labels and stable IDs come from the host. */
  apps?: MeetingStartApp[];
  allowedApps?: string[];
  blockedApps?: string[];
  onAppEnabledChange?: (id: string, enabled: boolean) => void;
  /** Current native observation state; omitted means no status has been established. */
  observationStatus?: MeetingAppObservationStatus;
}) {
  const effectiveMode = settings.options.some(option => option.id === mode) ? mode : settings.default_mode;
  const seen = new Set<string>();
  const appRows = (apps ?? []).filter(app => {
    if (!app || !validAppId(app.id) || typeof app.label !== 'string' || !app.label.trim() || seen.has(app.id)) return false;
    seen.add(app.id);
    return true;
  }).slice(0, 128);
  const modeContent = (
    <Container layout="vertical" gap="sm" padding="md" minWidth="0">
      <Text variant="heading">{settings.mode_section_title}</Text>
      <Text variant="body" color="subtle">{settings.description}</Text>
      <ChoiceTiles kind={settings.mode_control_kind as React.ComponentProps<typeof ChoiceTiles>['kind']}
        label={settings.mode_label} tiles={settings.options}
        chosen={effectiveMode} onPick={option => onChange(option.id as MeetingStartMode)} />
    </Container>
  );
  const appsContent = appRows.length > 0 || observationStatus ? (
    <Container layout="vertical" gap="xs" padding="md" minWidth="0">
      <Text variant="heading">{settings.apps_title}</Text>
      {observationStatus ? <Text variant="body-xs" color="faint" role="status">
        {observationStatus === 'inspected' && appRows.length === 0
          ? settings.observation_status_copy.inspected_empty
          : settings.observation_status_copy[observationStatus]}
      </Text> : null}
      <Text variant="body-xs" color="faint">{settings.apps_description}</Text>
      {appRows.map(app => {
        const blocked = blockedApps?.includes(app.id) ?? false;
        const enabled = !blocked && (allowedApps !== undefined
          ? allowedApps.length === 0 || allowedApps.includes(app.id)
          : app.active ?? false);
        return (
          <Container key={app.id} layout="horizontal" gap="sm" padding="xs" minWidth="0"
            alignItems="center" justifyContent="between">
            <Text variant="body">{app.label}</Text>
            <Switch size="md" label={app.label} checked={enabled}
              disabled={!onAppEnabledChange}
              onCheckedChange={next => onAppEnabledChange?.(app.id, next)} />
          </Container>
        );
      })}
    </Container>
  ) : null;
  return (
    <Container layout="vertical" gap="sm" minWidth="0">
      <Text variant="heading-lg">{settings.title}</Text>
      <ArrangedContents pieces={[
        { id: 'start-mode', label: settings.mode_section_title, content: modeContent },
        { id: 'observed-apps', label: settings.apps_title, content: appsContent },
      ]} arrangement={settings.composition.policy_controls.arrangement}
        keptAt={settings.composition.policy_controls.kept_at}
        words={settings.composition.policy_controls.words} />
    </Container>
  );
}
