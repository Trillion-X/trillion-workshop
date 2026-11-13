// Workspace adapter: calendar routes and copy stay with the app; the panel's
// rendering and preference interactions live in the shared UI part.

import * as React from 'react';
import { CalendarControls as SharedCalendarControls, type CalendarControlsProps as SharedCalendarControlsProps, type CalendarControlColor } from '../../parts/ui';
import calendarData from '../calendar.json';
import spaceSettings from '../space-settings.json';
import { calendarSelectionSourceId } from '../calendar-connections.mjs';
import words from './calendar-controls.json';
import { openAddress } from './open-screen';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import type { AvailabilityLinksProps } from '../../parts/calendar-booker/show/AvailabilityLinks';
import { later } from '../../parts/ui/show/load-later/later';

// Availability links are drawn only in the opened settings panel, never in the sources menu: fetched when first shown.
const AvailabilityLinks = later(() => import('../../parts/calendar-booker/show/AvailabilityLinks'), module => module.AvailabilityLinks);

export type {
  CalendarAccount,
  CalendarAccessRole,
  CalendarControlPreferences,
  CalendarControlSource,
  CalendarSelection,
} from '../../parts/ui';
import type { CalendarControlSource, WeeklyAvailabilitySchedule } from '../../parts/ui';

type ConnectionSource = CalendarControlSource & { base_source?: string; calendar_actions?: Record<string, unknown> };
type AvailabilityLinksBinding = Omit<AvailabilityLinksProps, 'accounts' | 'preferences' | 'sources' | 'connectionsBusy' | 'connectionsError' | 'onRefreshCalendars'> & {
  onRefreshCalendars?: () => void;
};
type WorkspaceCalendarControlsProps = Omit<SharedCalendarControlsProps,
  'sources' | 'words' | 'colorOptions' | 'hourHeightOptions' | 'timeFormats' | 'dateFormats' | 'calendarTypes' | 'menubarChoices' | 'navigation' | 'onAddAccount' | 'onSourceConnect' | 'onNavigate' | 'onCreateBookingLink' | 'renderPieces'> & {
    sources: ConnectionSource[];
    availabilityLinks?: AvailabilityLinksBinding;
  };

const sourceData = calendarData.sources as { id: string; connect?: { label: string; href: string }; look?: { tone?: string } }[];
const navigation = words.navigation as { id: string; label: string; href: string }[];
const colorOptions = spaceSettings.colours as CalendarControlColor[];
const { addAccountHref, hourHeightOptions, timeFormats, dateFormats, calendarTypes, menubarChoices, composition, ...controlWords } = words;

/** The date locale and clock the person's saved formats mean; the browser's own when none is saved. */
export function calendarFormatChoice(preferences: { timeFormat?: string; dateFormat?: string }): { dateLocale?: string; hour12?: boolean } {
  return {
    dateLocale: dateFormats.find(row => row.id === preferences.dateFormat)?.locale,
    hour12: timeFormats.find(row => row.id === preferences.timeFormat)?.hour12,
  };
}

/** The time zones the person keeps beside their device's: each one's id, zone and the name they call it. */
export function calendarZoneGutters(timeZones: readonly { id: string; zone: string; nickname: string }[] | undefined, deviceZone: string): { key: string; zone: string; heading: string }[] {
  return (timeZones ?? []).filter(row => row.zone !== deviceZone).map(row => ({ key: row.id, zone: row.zone, heading: row.nickname }));
}

function openRoute(href: string) {
  if (!openAddress(href)) window.open(href, href.startsWith('/') ? '_self' : '_blank', 'noopener');
}

/** Binds shared calendar controls to this workspace's copy and routes. */
export function CalendarControls(props: WorkspaceCalendarControlsProps): React.ReactElement {
  // A preferred-times schedule chosen for a new booking link; the nonce lets the same schedule start another link.
  const [bookingFrom, setBookingFrom] = React.useState<{ schedule: WeeklyAvailabilitySchedule; nonce: number } | null>(null);
  const sources = props.sources.map(source => ({
    ...source,
    selection: source.selection ? {
      ...source.selection,
      connected_at: props.accounts?.find(account => account.connection_id === source.selection?.connection_id
        && (!source.selection?.source_id || account.source_id === source.selection.source_id))?.connected_at,
    } : undefined,
    canCreate: Boolean(source.calendar_actions?.create),
    colorTone: props.preferences.sourceColors?.[source.id] ?? sourceData.find(row => row.id === (source.base_source ?? source.id))?.look?.tone,
    connectLabel: sourceData.find(row => row.id === (source.base_source ?? source.id))?.connect?.label,
  }));
  const accounts = props.accounts?.map(account => ({
    ...account,
    calendars: account.calendars.map(calendar => ({
      ...calendar,
      color_key: account.source_id ? calendarSelectionSourceId({ source_id: account.source_id, connection_id: account.connection_id, calendar_id: calendar.id }) : undefined,
      color_tone: sourceData.find(row => row.id === account.source_id)?.look?.tone,
    })),
  }));
  return <SharedCalendarControls
    {...props}
    renderPieces={props.presentation === 'sources-menu' ? undefined : pieces => {
      const availabilitySources = props.sources.map(source => ({ id: source.id, label: source.label, connected: source.connected,
        writable: source.writable, selection: source.selection }));
      const extra = props.availabilityLinks ? [{ id: 'availability-links', label: controlWords.availabilityLinks, content: <AvailabilityLinks
        {...props.availabilityLinks} startFrom={bookingFrom} accounts={accounts ?? []} preferences={props.preferences} sources={availabilitySources}
        connectionsBusy={props.connectionsBusy} connectionsError={props.connectionsError}
        onRefreshCalendars={props.availabilityLinks.onRefreshCalendars ?? (() => undefined)} /> }] : [];
      const arrangement = extra.length ? {
        ...composition.arrangement,
        sizes: [...composition.arrangement.sizes, 0],
        children: [...composition.arrangement.children, { kind: 'pane', surfaces: ['availability-links'] }],
      } : composition.arrangement;
      return <ArrangedContents pieces={[...pieces, ...extra]} arrangement={arrangement} keptAt={composition.kept_at} words={composition.words} />;
    }}
    sources={sources}
    accounts={accounts}
    words={controlWords}
    colorOptions={colorOptions}
    hourHeightOptions={hourHeightOptions}
    timeFormats={timeFormats}
    dateFormats={dateFormats}
    calendarTypes={calendarTypes}
    menubarChoices={menubarChoices}
    navigation={navigation}
    onAddAccount={() => openRoute(addAccountHref)}
    onSourceConnect={id => {
      const source = props.sources.find(row => row.id === id);
      const connect = sourceData.find(row => row.id === (source?.base_source ?? id))?.connect;
      if (connect) openRoute(connect.href);
    }}
    onCreateBookingLink={props.availabilityLinks ? schedule => setBookingFrom(current => ({ schedule, nonce: (current?.nonce ?? 0) + 1 })) : undefined}
    onNavigate={id => { const item = navigation.find(row => row.id === id); if (item) openRoute(item.href); }}
  />;
}

export type CalendarControlsProps = WorkspaceCalendarControlsProps;
