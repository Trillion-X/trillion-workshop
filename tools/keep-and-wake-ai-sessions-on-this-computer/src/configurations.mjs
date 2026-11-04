// Reusable UI state is an ordinary EEAF record. Lists, screens, humans and AIs
// use this one owner; credentials and data selected by a query stay elsewhere.
import { captureConfigurationSettings, selectedConfigurationAspects } from '../../keep-lists-of-rows/read-data/configuration-values.mjs';
import { resolveSavedViewTimeBound } from '../../keep-lists-of-rows/read-data/saved-view-engine.mjs';
import { failureOf } from './failure.mjs';

export const CONFIGURATION_TYPE = 'record:configuration';
const MAX_CONFIGURATION_PAGE = 200;
const prefix = `${CONFIGURATION_TYPE}:`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const listDefinition = {
  label: 'Saved configurations', about: 'Reusable filters, grouping, layouts and other settings. Open a configuration to change it in its original screen.',
  row_type: 'configuration', title_field: 'label', managed_rows: {open_field: 'open_path', create_on_screen: true, share_record: true}, fields: [
    {id: 'label', label: 'Name', kind: 'text'}, {id: 'target', label: 'Applies to', kind: 'text', editable: false},
    {id: 'owner_name', label: 'Created by', kind: 'text', editable: false}, {id: 'aspects', label: 'Settings included', kind: 'tags', editable: false},
    {id: 'updated_at', label: 'Updated', kind: 'date', editable: false}, {id: 'open_path', label: 'Open', kind: 'link-address', editable: false},
  ],
};

export class ConfigurationError extends Error {
  constructor(message, status = 400, code = 'invalid_configuration') { super(message); this.status = status; this.code = code; }
}
const configurationPageLimit = (limit, maximum) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new ConfigurationError(`Read between 1 and ${maximum} configurations at a time.`);
  return limit;
};
const keyOf = given => {
  const id = typeof given === 'string' && given.startsWith(prefix) ? given.slice(prefix.length) : given;
  if (typeof id !== 'string' || !ID.test(id)) throw new ConfigurationError('This configuration has an invalid identity.');
  return `${prefix}${id}`;
};
export const configurationOpenPath = (path, id, query = 'configuration') => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path))
    throw new ConfigurationError('A configuration opens on a Trillion screen.');
  const url = new URL(path, 'https://configuration.invalid');
  if (url.origin !== 'https://configuration.invalid') throw new ConfigurationError('A configuration opens on a Trillion screen.');
  url.searchParams.delete('configuration'); url.searchParams.delete('shared_configuration'); url.searchParams.delete('shared_offer');
  url.searchParams.set(query, id);
  return `${url.pathname}${url.search}${url.hash}`;
};

export function makeConfigurations({eeaf, newId = () => crypto.randomUUID(), now = () => Date.now(), owner = () => ({id: 'self', name: 'You'}),
  fieldsForTarget = () => null, writeMutation = (records, context) => eeaf.write(records, context), commitMutation = change => change()} = {}) {
  const read = given => {
    const id = keyOf(given), value = eeaf.read(id);
    return value ? { ...value, id, record_ref: id } : null;
  };
  const required = given => { const value = read(given); if (!value) throw new ConfigurationError('This configuration is no longer available.', 404, 'configuration_not_found'); return value; };
  const listRecord = () => {
    const existing = eeaf.read('list:saved-configurations');
    if (existing && existing.row_type !== 'configuration') return [];
    return existing ? [] : [{id: 'list:saved-configurations', type: 'list', value: listDefinition}];
  };
  const stale = () => new ConfigurationError('This configuration changed. Open the latest version before saving your changes.', 409, 'configuration_conflict');
  const safeOwner = () => {
    const actor = owner();
    return {id: typeof actor?.id === 'string' ? actor.id : 'self', name: typeof actor?.name === 'string' ? actor.name : 'You'};
  };
  return {
    get: read,
    list({target, limit = 100, before} = {}) {
      limit = configurationPageLimit(limit, MAX_CONFIGURATION_PAGE);
      const beforeId = before ? keyOf(before) : undefined;
      if (target !== undefined && (typeof target !== 'string' || !target.trim() || target.length > 300)) throw new ConfigurationError('Choose a valid configuration target.');
      // A target-specific index prevents opening one screen from walking every
      // configuration in the account. Page ties use immutable record identity.
      if (target && eeaf.indexReady && !eeaf.indexReady(CONFIGURATION_TYPE, 'target'))
        throw new ConfigurationError('Saved configurations are being indexed. Try again shortly.', 503, 'configuration_index_pending');
      const ids = target
        ? eeaf.scan(CONFIGURATION_TYPE, 'target', {equal: [target], reverse: true, limit: limit + 1, ...(beforeId ? {idTo: beforeId} : {})}).map(row => row.id)
        : eeaf.ids(CONFIGURATION_TYPE, {limit: limit + 1, ...(beforeId ? {before: beforeId} : {})});
      const rows = ids.slice(0, limit).map(read).filter(Boolean);
      return {configurations: rows, next_before: ids.length > limit ? ids[limit - 1] : null};
    },
    save(input = {}, {actor = {by: 'configurations'}} = {}) {
      if (!object(input)) throw new ConfigurationError('Configuration changes must be an object.');
      const id = keyOf(input.id ?? newId()), earlier = read(id);
      if (earlier && input.expected_revision !== earlier.revision) throw stale();
      if (!earlier && input.expected_revision !== undefined) throw new ConfigurationError('This configuration was removed. It cannot be overwritten.', 409, 'configuration_removed');
      const label = input.label ?? earlier?.label;
      const target = input.target ?? earlier?.target;
      if (typeof label !== 'string' || !label.trim() || label.length > 160) throw new ConfigurationError('Give this configuration a name of at most 160 characters.');
      if (typeof target !== 'string' || !target.trim() || target.length > 300 || /[\u0000-\u001f]/.test(target)) throw new ConfigurationError('Choose the screen or record this configuration applies to.');
      const format = input.format ?? earlier?.format ?? 'record-view';
      if (input.settings !== undefined && !object(input.settings)) throw new ConfigurationError('Configuration settings must be an object.');
      const settings = {...(earlier?.settings ?? {}), ...(input.settings ?? {})};
      const fieldIds = fieldsForTarget(target) ?? input.field_ids ?? earlier?.field_ids ?? [];
      if (!Array.isArray(fieldIds) || fieldIds.length > 256 || fieldIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new ConfigurationError('Choose the available fields for this configuration.');
      let aspects, kept;
      try {
        aspects = selectedConfigurationAspects(input.aspects ?? earlier?.aspects, format, settings);
        kept = captureConfigurationSettings(settings, aspects, fieldIds, format);
      } catch (error) { throw new ConfigurationError(error.message); }
      const at = new Date(now()).toISOString(), by = earlier?.owner ?? safeOwner();
      const basePath = input.open_path ?? earlier?.open_path ?? (target.startsWith('list:') ? `/lists/${encodeURIComponent(target.slice(5))}` : target === 'screen:connections' ? '/connections' : null);
      const openPath = configurationOpenPath(basePath, id);
      const value = {label: label.trim(), target, format, aspects, settings: kept, field_ids: [...new Set(fieldIds)],
        revision: (earlier?.revision ?? 0) + 1, owner: by, owner_name: by.name,
        created_at: earlier?.created_at ?? at, updated_at: at, open_path: openPath,
        ...(earlier?.copied_from ? {copied_from: earlier.copied_from} : {}),
        ...(typeof input.copied_from === 'string' && !earlier ? {copied_from: input.copied_from} : {})};
      return commitMutation(() => {
        writeMutation([...listRecord(), {id, type: CONFIGURATION_TYPE, value}], {actor});
        return required(id);
      }, {operation: 'configurations:save', source: id});
    },
    remove(id, expectedRevision, {actor = {by: 'configurations'}} = {}) {
      const current = read(id);
      if (current && current.revision !== expectedRevision) throw stale();
      return commitMutation(() => {
        if (!current) return {removed: keyOf(id), already_removed: true};
        writeMutation([{id: current.id, type: CONFIGURATION_TYPE, value: null}], {actor});
        return {removed: current.id};
      }, {operation: 'configurations:remove', source: keyOf(id)});
    },
    mutateListRows(list, {rows = [], remove = []} = {}, context = {}) {
      // The generic Lists adapter dispatches configuration mutations to this
      // same owner. A row rename increments its revision; metadata cannot be
      // rewritten behind a recipient editor's optimistic concurrency check.
      if (list.row_type !== 'configuration') return null;
      if (!Array.isArray(rows) || !Array.isArray(remove) || rows.length + remove.length > 200)
        throw new ConfigurationError('Change at most 200 configurations together.');
      const staged = new Map(), changes = new Map();
      const transaction = makeConfigurations({eeaf: {...eeaf, read: id => staged.has(id) ? staged.get(id) : eeaf.read(id)}, now, owner, fieldsForTarget,
        writeMutation: records => {for (const record of records) {staged.set(record.id, record.value); changes.set(record.id, record);}}});
      const kept = [], removed = [];
      for (const row of rows) {
        if (typeof row?.id !== 'string' || !object(row.values) || Object.keys(row.values).some(key => key !== 'label'))
          throw new ConfigurationError('Change configuration settings on their original screen or with save_configuration. This list can rename existing configurations.');
        const current = transaction.get(row.id);
        if (!current) throw new ConfigurationError('Create a configuration from the screen whose settings you want to save.');
        const saved = transaction.save({id: current.id, label: row.values.label, expected_revision: row.expected_revision ?? current.revision}, context);
        const {id, record_ref, ...values} = saved; kept.push({id: id.slice(prefix.length), values});
      }
      for (const id of remove) {
        const current = transaction.get(id);
        if (!current) continue;
        transaction.remove(current.id, current.revision, context); removed.push(current.id.slice(prefix.length));
      }
      if (changes.size) writeMutation([...changes.values()], context);
      return {list_id: list.id, kept, removed};
    },
    duplicate(id, input = {}, context = {}) {
      const source = required(id);
      return this.save({label: input.label ?? `${source.label} copy`, target: input.target ?? source.target,
        format: source.format, settings: source.settings, aspects: source.aspects, field_ids: source.field_ids,
        open_path: input.open_path ?? source.open_path, copied_from: source.id}, context);
    },
  };
}

export async function handleConfigurationsRequest(configurations, request, shared = {}, context = {}) {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
  try {
    const sharedResponse = answer => answer?.refused ? Response.json(answer.refused, {status: answer.refused.status}) : Response.json(answer);
    if (request.method === 'POST' && parts.length === 3 && parts[1] === 'context' && parts[2] === 'time-bound') {
      const input = await request.json();
      if (!object(input) || !object(input.point) || typeof input.now !== 'number' || !Number.isFinite(input.now))
        throw new ConfigurationError('A time bound needs a point and a valid clock.');
      let settings;
      try { settings = captureConfigurationSettings({time: {field: 'time', after: input.point}}, ['time'], ['time']); }
      catch (error) { throw new ConfigurationError(error.message); }
      // Resolve references inside the receiving account. Only the resulting
      // timestamp crosses this boundary; a saved query cannot grant record access.
      const value = await resolveSavedViewTimeBound(settings.time.after, {...context, now: input.now});
      return Response.json({value}, {headers: {'cache-control': 'no-store'}});
    }
    if (parts.length === 3 && ['shared', 'offers'].includes(parts[1])) {
      const code = decodeURIComponent(parts[2]);
      if (request.method === 'GET') return sharedResponse(parts[1] === 'offers'
        ? await shared.readOffer(code) : await shared.read(code, {access_code: url.searchParams.get('access_code')}));
      if (request.method === 'POST' && parts[1] === 'shared') {
        const input = await request.json();
        if (!object(input)) throw new ConfigurationError('Configuration changes must be an object.');
        return sharedResponse(await shared.edit(code, input, {access_code: url.searchParams.get('access_code')}));
      }
      return Response.json({error: 'Not found'}, {status: 404});
    }
    if (request.method === 'GET' && parts.length === 1 && url.searchParams.get('visibility') === 'shared')
      return Response.json(await shared.list({target: url.searchParams.get('target') || undefined, before: url.searchParams.get('before') || undefined}));
    if (request.method === 'GET' && parts.length === 1) return Response.json(configurations.list({target: url.searchParams.get('target') || undefined,
      limit: configurationPageLimit(Number(url.searchParams.get('limit') ?? 100), MAX_CONFIGURATION_PAGE), before: url.searchParams.get('before') || undefined}));
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (request.method === 'GET' && parts.length === 2) {
      const configuration = configurations.get(id);
      return Response.json(configuration ? {configuration} : {error: 'This configuration is no longer available.', code: 'configuration_not_found'}, {status: configuration ? 200 : 404});
    }
    if (request.method !== 'POST') return Response.json({error: 'Not found'}, {status: 404});
    const input = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigurationError('Configuration changes must be an object.');
    const actor = {by: request.headers.get('x-trillion-app') || 'person'};
    // JSON parsing may await; native admission is refreshed at the actual local mutation boundary.
    if (context.beforeMutation) {
      try { await context.beforeMutation('configurations:request', {path: url.pathname, body: input}); }
      catch (error) {
        if ([401, 402, 403].includes(error?.status) && !failureOf(error).tries_again_later)
          throw new ConfigurationError('Current access does not admit this configuration change.', error.status, 'configuration_access_refused');
        throw error;
      }
    }
    if (parts.length === 1) return Response.json({configuration: configurations.save(input, {actor})});
    if (parts.length === 3 && parts[2] === 'duplicate') return Response.json({configuration: configurations.duplicate(id, input, {actor})});
    if (parts.length === 2) return Response.json(input.remove === true
      ? configurations.remove(id, input.expected_revision, {actor})
      : {configuration: configurations.save({...input, id}, {actor})});
    return Response.json({error: 'Not found'}, {status: 404});
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    if (error instanceof ConfigurationError || error.name === 'SharingError')
      return Response.json({error: error.message, code: error.code ?? 'configuration_share_denied'}, {status: error.status ?? 403});
    if (error instanceof SyntaxError || error instanceof URIError)
      return Response.json({error: 'The configuration request is invalid.', code: 'invalid_configuration'}, {status: 400});
    return Response.json({error: 'Saved configurations are temporarily unavailable. Try again.', code: 'configuration_unavailable'}, {status: 503});
  }
}

export const configurationTools = call => [
  {name: 'list_configurations', description: 'Read reusable saved settings in this account, optionally for one target. Shared configurations are discovered through shared_with_me and are separately permission checked.', inputSchema: {type: 'object', properties: {target: {type: 'string'}, visibility: {type: 'string', enum: ['owned','shared']}, limit: {type: 'integer', minimum: 1, maximum: 200}, before: {type: 'string'}}}, run: input => call(`/configurations?${new URLSearchParams(Object.entries(input ?? {}).map(([key, value]) => [key, String(value)]))}`)},
  {name: 'read_shared_configuration', description: 'Read the exact definition behind a shared configuration link with this account’s proven identity and current permissions. Settings confer no access to the data they select.', inputSchema: {type: 'object', required: ['code'], properties: {code: {type: 'string'}, access_code: {type: 'string'}}}, run: ({code, access_code}) => call(`/configurations/shared/${encodeURIComponent(code)}${access_code ? `?access_code=${encodeURIComponent(access_code)}` : ''}`)},
  {name: 'edit_shared_configuration', description: 'Edit only the configuration definition, using a current edit grant and the revision just read. Expired, revoked, view-only and stale writes are refused by the original owner.', inputSchema: {type: 'object', required: ['code','expected_revision'], properties: {code: {type: 'string'}, access_code: {type: 'string'}, expected_revision: {type: 'integer'}, label: {type: 'string'}, settings: {type: 'object'}, aspects: {type: 'array', items: {type: 'string'}}}}, run: ({code, access_code, ...input}) => call(`/configurations/shared/${encodeURIComponent(code)}${access_code ? `?access_code=${encodeURIComponent(access_code)}` : ''}`, input)},
  {name: 'read_configuration', description: 'Read the exact persisted configuration by its record identity, independent of recent, filtered or paginated lists.', inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}}, run: ({id}) => call(`/configurations/${encodeURIComponent(id)}`)},
  {name: 'save_configuration', description: 'Create or update a named full or partial configuration. Updates require the revision just read. Settings refer to existing records and confer no access to them.', inputSchema: {type: 'object', required: [], properties: {id: {type: 'string'}, expected_revision: {type: 'integer'}, label: {type: 'string'}, target: {type: 'string'}, settings: {type: 'object'}, aspects: {type: 'array', items: {type: 'string'}}, field_ids: {type: 'array', items: {type: 'string'}}, format: {type: 'string', enum: ['record-view','settings']}, open_path: {type: 'string'}}}, run: input => call(input.id ? `/configurations/${encodeURIComponent(input.id)}` : '/configurations', input)},
  {name: 'delete_configuration', description: 'Remove an owned saved configuration at the revision just read. Other saved configurations and the data its settings select stay intact.', inputSchema: {type: 'object', required: ['id','expected_revision'], properties: {id: {type: 'string'}, expected_revision: {type: 'integer'}}}, run: ({id, expected_revision}) => call(`/configurations/${encodeURIComponent(id)}`, {remove: true, expected_revision})},
  {name: 'duplicate_configuration', description: 'Make an independently editable copy of an owned configuration in the same EEAF store, retaining its source reference.', inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}, label: {type: 'string'}, target: {type: 'string'}, open_path: {type: 'string'}}}, run: ({id, ...input}) => call(`/configurations/${encodeURIComponent(id)}/duplicate`, input)},
];

export const configurationAnnotations = {
  read_shared_configuration: {title: 'Read shared settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  edit_shared_configuration: {title: 'Edit shared settings', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  list_configurations: {title: 'Find saved settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  read_configuration: {title: 'Read saved settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  save_configuration: {title: 'Save settings', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  delete_configuration: {title: 'Remove saved settings', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  duplicate_configuration: {title: 'Copy saved settings', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
};
