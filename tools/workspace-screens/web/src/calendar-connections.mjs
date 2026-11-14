// Calendar application adapter: provider identity, tools, role names, and row
// shapes live with the calendar source declaration; reusable account discovery
// and exact-incarnation binding belong to service-connections.
import settings from './calendar.json' with { type: 'json' };
import {
  buildCalendarSources as buildSharedCalendarSources,
  calendarSelectionSourceId as sharedCalendarSelectionSourceId,
  listSelectableCalendars as listSharedSelectableCalendars,
  validateCalendarRouteChoice,
  validateCalendarSelections as validateSharedCalendarSelections,
} from 'trillion-workshop/tools/connect-a-service-and-seal-its-key/read-data/calendar-connection-options.ts';

const providersOf = (configured = settings) => (configured?.sources ?? [])
  .filter(source => source.calendar_connection)
  .map(source => ({ source, declaration: source.calendar_connection }));

export const listSelectableCalendars = (io, configured = settings) =>
  listSharedSelectableCalendars(io, providersOf(configured).map(row => row.declaration));

export const validateCalendarSelections = (selections, accountIndex, configured = settings) =>
  validateSharedCalendarSelections(selections, accountIndex, providersOf(configured).map(row => row.declaration));

export const calendarSelectionSourceId = selection => {
  const providers = providersOf();
  const sourceId = selection.source_id ?? (providers.length === 1 ? providers[0].declaration.source_id : undefined);
  if (!sourceId) throw new TypeError('The calendar provider source_id is required.');
  return sharedCalendarSelectionSourceId(sourceId, selection);
};

export const buildCalendarSources = ({ selections, accountIndex, io, settings: configured = settings } = {}) => {
  const providers = providersOf(configured);
  return buildSharedCalendarSources({
    selections, accountIndex, io,
    baseSources: providers.map(row => row.source),
    declaration: providers.map(row => row.declaration),
  });
};

export { validateCalendarRouteChoice };

export const calendarConnectionLimits = Object.freeze({
  get max_calendars_per_account() { return Math.max(0, ...providersOf().map(row => row.declaration.limits.max_calendars_per_account)); },
  get max_selections() { const values = providersOf().map(row => row.declaration.limits.max_selections); return values.length ? Math.min(...values) : 0; },
  get max_pages() { return Math.max(0, ...providersOf().map(row => row.declaration.limits.max_pages)); },
});
