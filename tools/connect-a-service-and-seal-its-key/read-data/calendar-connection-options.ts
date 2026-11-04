/**
 * Provider-neutral discovery and exact-account binding for connected calendar
 * sources. Calendar/provider vocabulary and response paths are supplied by
 * the caller's calendar declarations; this owner only applies those rules to
 * the current service-connection rows.
 */

type Row = Record<string, any>;
type CalendarConnectionDeclaration = {
  [key: string]: any;
  source_id: string;
  vendor: string;
  required_capability_id?: string;
  label: string;
  tools: { list_calendars: string; list_events: string; list_busy_times?: string };
  readable_roles: string[];
  writable_roles: string[];
  calendar_id_path: string[];
  calendar_access_role_path: string[];
  calendar_label_path: string[];
  calendar_time_zone_path: string[];
  calendar_primary_path: string[];
  calendar_id_input_field: string;
  items_path: string[];
  next_page_path: string[];
  page_input_field: string;
  limits: { max_calendars_per_account: number; max_selections: number; max_pages: number };
  busy_source?: {
    input: Row;
    rows: string[];
    required_rows: boolean;
    errors_path: string[];
    default_title: string;
    fields: Row;
  };
};

const isObject = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validInstant = (value: unknown): value is string => hasText(value) && Number.isFinite(Date.parse(value));
const pathValue = (value: unknown, path: string[]) => path.reduce<any>((current, key) => current?.[key], value);
const fill = (value: any, values: Record<string, string>): any => {
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  return typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : value;
};
const fail = (message: string, cause?: unknown) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { retryable: false });

function declarationOf(value: unknown): CalendarConnectionDeclaration {
  if (!isObject(value) || !hasText(value.source_id) || !hasText(value.vendor)
    || !isObject(value.tools) || !hasText(value.tools.list_calendars) || !hasText(value.tools.list_events)
    || !Array.isArray(value.readable_roles) || !Array.isArray(value.writable_roles)
    || !Array.isArray(value.calendar_id_path) || !Array.isArray(value.calendar_access_role_path)
    || !Array.isArray(value.calendar_label_path) || !Array.isArray(value.calendar_time_zone_path)
    || !Array.isArray(value.calendar_primary_path) || !Array.isArray(value.items_path)
    || !Array.isArray(value.next_page_path) || !hasText(value.page_input_field) || !hasText(value.calendar_id_input_field)
    || !isObject(value.limits) || !Number.isInteger(value.limits.max_selections)
    || !Number.isInteger(value.limits.max_pages) || !Number.isInteger(value.limits.max_calendars_per_account)) {
    throw new TypeError('A complete calendar connection declaration is required.');
  }
  return value as CalendarConnectionDeclaration;
}

function declarationsOf(value: unknown): CalendarConnectionDeclaration[] {
  const declarations = (Array.isArray(value) ? value : [value]).map(declarationOf);
  if (!declarations.length) return [];
  const sourceIds = new Set<string>();
  const vendors = new Set<string>();
  for (const declaration of declarations) {
    if (sourceIds.has(declaration.source_id) || vendors.has(declaration.vendor))
      throw new TypeError('Calendar provider declarations must have unique source and vendor identities.');
    sourceIds.add(declaration.source_id);
    vendors.add(declaration.vendor);
  }
  return declarations;
}

function accountLabel(account: Row, declaration: CalendarConnectionDeclaration) {
  return hasText(account.account_label) ? account.account_label
    : hasText(account.service) ? account.service : declaration.label;
}

/** Optional provider metadata cannot make otherwise readable calendars unavailable. */
export async function readCalendarEventColors(io: Row, declaration: Row, binding?: Row, requestKey?: string) {
  const catalog = declaration.event_color_catalog;
  if (!isObject(catalog) || !hasText(catalog.tool)) return {};
  try {
    const tool = binding ? await io.bind(catalog.tool, binding) : catalog.tool;
    if (!hasText(tool)) throw fail('Event colors could not be checked.');
    const result = await io.runTool(tool, {}, requestKey ?? `calendar-colors:${binding?.connection_id ?? declaration.source_id}:${binding?.connected_at ?? 'default'}:${crypto.randomUUID()}`);
    const rows = pathValue(result?.output, catalog.rows_path);
    if (result?.state !== 'completed' || !isObject(rows)) throw fail('Event colors could not be checked.');
    const choices = Object.entries(rows).slice(0, catalog.max_colors).flatMap(([id, row]) => {
      const color = pathValue(row, catalog.color_path);
      if (!hasText(id) || Array.isArray(catalog.supported_ids) && !catalog.supported_ids.includes(id) || !/^#[0-9a-f]{6}$/i.test(color ?? '')) return [];
      const label = catalog.label_path?.length ? pathValue(row, catalog.label_path) : null;
      return [{ value: id, label: hasText(label) ? label : String(catalog.label_template).replace('{id}', id), color }];
    });
    return { event_colors: choices };
  } catch { return { event_colors_unavailable: true }; }
}

export function withCalendarEventColors(base: Row, metadata: Row, writable = true) {
  return { ...base, event_colors: metadata.event_colors, event_colors_unavailable: metadata.event_colors_unavailable,
    event_properties: writable && base.event_properties ? { ...base.event_properties,
      ...(base.event_properties.color ? { color: { ...base.event_properties.color, choices: [...base.event_properties.color.choices, ...(metadata.event_colors ?? [])] } } : {}),
    } : undefined };
}

/** Discover readable calendars, binding every request to one current account incarnation. */
export async function listSelectableCalendars(io: Row, rawDeclarations: unknown) {
  const declarations = declarationsOf(rawDeclarations);
  if (typeof io?.connections !== 'function' || typeof io?.bind !== 'function' || typeof io?.runTool !== 'function')
    throw new TypeError('connections, bind and runTool are required.');
  const answer = await io.connections();
  const rows = Array.isArray(answer) ? answer : answer?.connections;
  if (!Array.isArray(rows)) throw fail('Connected calendars could not be checked.');
  const declarationByVendor = new Map(declarations.map(declaration => [declaration.vendor, declaration]));
  const accounts = rows.filter((row: Row) => declarationByVendor.has(row?.vendor) && row?.status === 'connected' && row.can_send !== false)
    .sort((a: Row, b: Row) => String(a.vendor).localeCompare(String(b.vendor)) || String(a.connection_id).localeCompare(String(b.connection_id)));
  const output = [];
  for (const account of accounts) {
    const declaration = declarationByVendor.get(account.vendor)!;
    if (!hasText(account.connection_id)) throw fail('A connected calendar account has no usable identity.');
    if (hasText(declaration.required_capability_id)
      && account.capabilityChoices?.[declaration.required_capability_id] === 'disabled') {
      output.push({ source_id: declaration.source_id, provider_vendor: declaration.vendor, connection_id: account.connection_id,
        connected_at: account.connected_at, account_label: accountLabel(account, declaration), calendars: [], unavailable: true,
        capability_disabled: true, said: declaration.words?.capability_disabled ?? 'Calendar access is turned off for this connected account.' });
      continue;
    }
    try {
      const binding = { connection_id: account.connection_id, connected_at: account.connected_at };
      const bound = await io.bind(declaration.tools.list_calendars, binding);
      if (!hasText(bound)) throw fail('Connected calendars could not be checked.');
      const calendars = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let page = 0; page < declaration.limits.max_pages; page += 1) {
        const result = await io.runTool(bound, cursor ? { [declaration.page_input_field]: cursor } : {},
          `calendar-selection:${account.connection_id}:${account.connected_at}:${crypto.randomUUID()}:${page}`);
        const items = pathValue(result?.output, declaration.items_path);
        if (result?.state !== 'completed' || !Array.isArray(items)) throw fail('Connected calendars could not be checked.');
        for (const row of items) {
          if (!isObject(row)) continue;
          const id = pathValue(row, declaration.calendar_id_path);
          const role = pathValue(row, declaration.calendar_access_role_path);
          if (!hasText(id) || !declaration.readable_roles.includes(role)) continue;
          if (calendars.length >= declaration.limits.max_calendars_per_account) throw fail('Connected calendars could not be checked.');
          const labelPath = declaration.calendar_label_path;
          const timeZonePath = declaration.calendar_time_zone_path;
          const primaryPath = declaration.calendar_primary_path;
          const label = pathValue(row, labelPath);
          const timezone = pathValue(row, timeZonePath);
          const writable = declaration.writable_roles.includes(role);
          calendars.push({ id, summary: hasText(label) ? label : id, ...(pathValue(row, primaryPath) === true ? { primary: true } : {}), access_role: role, writable, read_mode: declaration.busy_role === role ? 'busy' : 'events', ...(hasText(timezone) ? { time_zone: timezone } : {}) });
        }
        const next = pathValue(result.output, declaration.next_page_path);
        if (!next) { complete = true; break; }
        if (!hasText(next) || seen.has(next)) throw fail('Connected calendars could not be checked.');
        seen.add(next);
        cursor = next;
      }
      if (!complete) throw fail('Connected calendars could not be checked.');
      calendars.sort((a, b) => Number(b.primary === true) - Number(a.primary === true) || a.summary.localeCompare(b.summary) || a.id.localeCompare(b.id));
      const colors = await readCalendarEventColors(io, declaration, binding);
      output.push({ source_id: declaration.source_id, provider_vendor: declaration.vendor, connection_id: account.connection_id, account_label: accountLabel(account, declaration), ...(hasText(account.connected_at) ? { connected_at: account.connected_at } : {}), calendars, ...colors });
    } catch {
      output.push({ source_id: declaration.source_id, provider_vendor: declaration.vendor, connection_id: account.connection_id, connected_at: account.connected_at, account_label: accountLabel(account, declaration), calendars: [], unavailable: true, said: declaration.words?.unavailable ?? 'This account’s calendars could not be checked. Reconnect it or try again.' });
    }
  }
  return { accounts: output };
}

/** Validate selections only against current exact account and calendar rows. */
export function validateCalendarSelections(selections: unknown, rawAccounts: unknown, rawDeclarations: unknown) {
  const declarations = declarationsOf(rawDeclarations);
  const declarationBySource = new Map(declarations.map(declaration => [declaration.source_id, declaration]));
  const maxSelections = declarations.length ? Math.min(...declarations.map(declaration => declaration.limits.max_selections)) : 0;
  if (!Array.isArray(selections) || selections.length > maxSelections)
    throw new TypeError(`Choose at most ${maxSelections} calendars.`);
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : (rawAccounts as any)?.accounts;
  if (!Array.isArray(accounts)) throw new TypeError('Current connected accounts are required.');
  const seen = new Set<string>();
  return selections.map((selection: any) => {
    if (!isObject(selection) || !hasText(selection.connection_id) || !hasText(selection.calendar_id))
      throw new TypeError('Each selected calendar needs its exact connected account and calendar.');
    const key = `${selection.source_id ?? ''}\u0000${selection.connection_id}\u0000${selection.calendar_id}`;
    if (seen.has(key)) throw new TypeError('A calendar can only be selected once.');
    seen.add(key);
    const account = accounts.find((row: Row) => row.connection_id === selection.connection_id
      && (!selection.source_id || row.source_id === selection.source_id));
    if (!account || !validInstant(account.connected_at)) throw new TypeError('The selected calendar account is no longer connected.');
    const sourceId = selection.source_id ?? account.source_id ?? (declarations.length === 1 ? declarations[0].source_id : undefined);
    const declaration = declarationBySource.get(sourceId);
    if (!declaration || account.source_id && account.source_id !== declaration.source_id)
      throw new TypeError('The selected calendar provider is no longer available.');
    if (hasText(declaration.required_capability_id)
      && account.capabilityChoices?.[declaration.required_capability_id] === 'disabled')
      throw new TypeError('Calendar access is turned off for this connected account.');
    if (selection.connected_at && selection.connected_at !== account.connected_at) throw new TypeError('The selected calendar account changed. Select that account again.');
    const calendar = account.calendars?.find((row: Row) => row.id === selection.calendar_id);
    if (!calendar || !declaration.readable_roles.includes(calendar.access_role)) throw new TypeError('The selected calendar is unavailable or cannot be read.');
    return { source_id: declaration.source_id, connection_id: account.connection_id, connected_at: account.connected_at, calendar_id: calendar.id, account_label: account.account_label, calendar_label: calendar.summary, access_role: calendar.access_role };
  });
}

const encode = (value: string) => encodeURIComponent(value);
export const calendarSelectionSourceId = (providerId: string, selection: { connection_id: string; calendar_id: string }) =>
  `${providerId}:${encode(selection.connection_id)}:${encode(selection.calendar_id)}`;

function unavailableSource(base: Row, selection: Row, declaration: CalendarConnectionDeclaration) {
  const { calendar_actions: _calendarActions, actions: _actions, move: _move, connect: _connect, ...readOnlyBase } = base;
  const account = hasText(selection.account_label) ? selection.account_label : base.look?.label;
  const calendar = hasText(selection.calendar_label) ? selection.calendar_label : selection.calendar_id;
  return { ...readOnlyBase, id: calendarSelectionSourceId(declaration.source_id, selection as any), base_source: declaration.source_id,
    input: { ...(base.input ?? {}), [declaration.calendar_id_input_field]: selection.calendar_id }, look: { ...(base.look ?? {}), label: [calendar, account].filter(hasText).join(' · ') },
    calendar_actions: {}, actions: [], writable: false, read_mode: 'unavailable', unavailable: true,
    selection: { source_id: declaration.source_id, connection_id: selection.connection_id, calendar_id: selection.calendar_id },
    ...(declaration.readable_roles.includes(selection.access_role) ? { access_role: selection.access_role } : {}) };
}

/** Build sources from explicit selections, binding their reads and writes to current exact accounts. */
export async function buildCalendarSources({ selections, accountIndex, io, baseSource, baseSources, declaration: rawDeclarations }: Row) {
  const declarations = declarationsOf(rawDeclarations);
  const bases: Row[] = Array.isArray(baseSources) ? baseSources : isObject(baseSource) ? [baseSource] : [];
  const providers = declarations.map(declaration => {
    const base = bases.find(row => row.id === declaration.source_id);
    if (!isObject(base)) throw new TypeError(`The declared calendar source ${declaration.source_id} is missing.`);
    return { declaration, base };
  });
  const providerBySource = new Map(providers.map(provider => [provider.declaration.source_id, provider]));
  const maxSelections = declarations.length ? Math.min(...declarations.map(declaration => declaration.limits.max_selections)) : 0;
  if (selections === undefined || selections === null) return bases;
  if (Array.isArray(selections) && selections.length === 0) return [];
  if (!Array.isArray(selections) || selections.length > maxSelections) throw new TypeError(`Choose at most ${maxSelections} calendars.`);
  if (typeof io?.bind !== 'function') throw new TypeError('bind is required for selected calendars.');
  const seen = new Set<string>();
  for (const selection of selections) {
    if (!isObject(selection) || !hasText(selection.connection_id) || !hasText(selection.calendar_id)) throw new TypeError('Each selected calendar needs its exact connected account and calendar.');
    const key = `${selection.source_id ?? ''}\u0000${selection.connection_id}\u0000${selection.calendar_id}`;
    if (seen.has(key)) throw new TypeError('A calendar can only be selected once.');
    seen.add(key);
  }
  const candidates = selections.map((selection: Row) => {
    try {
      const valid = validateCalendarSelections([selection], accountIndex, declarations)[0];
      return { selection: valid, provider: providerBySource.get(valid.source_id) };
    } catch {
      const currentAccounts = Array.isArray(accountIndex) ? accountIndex : accountIndex?.accounts;
      const account = currentAccounts?.find((row: Row) => row.connection_id === selection.connection_id);
      const sourceId = account?.source_id ?? selection.source_id ?? (declarations.length === 1 ? declarations[0].source_id : undefined);
      return { selection, provider: providerBySource.get(sourceId), unavailable: true };
    }
  });
  return Promise.all(candidates.map(async ({ selection, provider, unavailable }: any) => {
    if (!provider) return { id: calendarSelectionSourceId(selection.source_id ?? 'calendar', selection), base_source: selection.source_id, selection: { source_id: selection.source_id, connection_id: selection.connection_id, calendar_id: selection.calendar_id }, writable: false, read_mode: 'unavailable', unavailable: true, said: 'This calendar provider is no longer available.', actions: [], calendar_actions: {} };
    const { declaration, base } = provider;
    if (unavailable) return unavailableSource(base, selection, declaration);
    const writable = declaration.writable_roles.includes(selection.access_role);
    const binding = { connection_id: selection.connection_id, connected_at: selection.connected_at };
    try {
      const [readTool, ...actionTools] = await Promise.all([
        io.bind(declaration.busy_role && selection.access_role === declaration.busy_role && declaration.tools.list_busy_times ? declaration.tools.list_busy_times : declaration.tools.list_events, binding),
        ...(writable ? Object.values(base.calendar_actions ?? {}).map((action: any) => io.bind(action.tool, binding)) : []),
      ]);
      if (!hasText(readTool) || actionTools.some((tool: unknown) => !hasText(tool))) throw fail('The selected calendar account could not be bound.');
      let index = 0;
      const calendar_actions = writable ? Object.fromEntries(Object.entries(base.calendar_actions ?? {}).map(([id, action]: any) => [id, { ...action, tool: actionTools[index++], input_defaults: { ...(action.input_defaults ?? {}), [declaration.calendar_id_input_field]: selection.calendar_id } }])) : {};
      const accounts = Array.isArray(accountIndex) ? accountIndex : accountIndex?.accounts;
      const account = accounts?.find((row: Row) => row.connection_id === binding.connection_id && row.connected_at === binding.connected_at);
      const calendarZone = account?.calendars?.find((row: Row) => row.id === selection.calendar_id)?.time_zone;
      const selectedId = calendarSelectionSourceId(declaration.source_id, selection);
      const readOnlyBase = writable ? base : (({ calendar_actions: _calendarActions, actions: _actions, move: _move, ...rest }: Row) => rest)(base);
      return { ...withCalendarEventColors(readOnlyBase, account ?? {}, writable), id: selectedId, base_source: declaration.source_id, tool: readTool,
        input: { ...(base.input ?? {}), [declaration.calendar_id_input_field]: selection.calendar_id },
        ...(declaration.busy_role && selection.access_role === declaration.busy_role && declaration.busy_source ? fill(declaration.busy_source, { '{calendar_id}': selection.calendar_id }) : {}),
        look: { ...(base.look ?? {}), label: `${selection.calendar_label} · ${selection.account_label}` }, calendar_actions,
        ...(writable ? {} : { actions: [] }), writable, read_mode: declaration.busy_role === selection.access_role ? 'busy' : 'events', access_role: selection.access_role,
        capabilityChoices: account?.capabilityChoices ?? {},
        ...(hasText(calendarZone) ? { time_zone: calendarZone } : {}),
        selection: { source_id: declaration.source_id, connection_id: selection.connection_id, connected_at: selection.connected_at, calendar_id: selection.calendar_id } };
    } catch { return unavailableSource(base, selection, declaration); }
  }));
}

export function validateCalendarRouteChoice(choice: unknown, sources: unknown) {
  if (!isObject(choice) || !hasText(choice.source_id) || !Array.isArray(sources)) throw new TypeError('Choose a current calendar source.');
  const source = sources.find((row: any) => row.id === choice.source_id);
  if (!source) throw new TypeError('The selected calendar is no longer available.');
  if (source.selection) {
    if (choice.connection_id !== source.selection.connection_id || choice.calendar_id !== source.selection.calendar_id) throw new TypeError('The selected calendar does not match this source.');
  } else if (choice.connection_id !== undefined || choice.calendar_id !== undefined) throw new TypeError('The default calendar source cannot be redirected.');
  return source;
}
