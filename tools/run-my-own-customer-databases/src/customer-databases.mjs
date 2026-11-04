// Customer database carrier tools adapt into addressed resource commands.
// Inputs name logical resources; the authenticated composition selects commitment owners.
import { readBoundedJson } from '../../keep-and-wake-ai-sessions-on-this-computer/src/read-bounded-json.mjs';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Domain API adapter only. The supplied command names the admitted resource owner;
// there is no account-side metadata or record implementation behind this surface.
export function customerDatabases(command) {
  if (typeof command !== 'function') throw new TypeError('An admitted database command supply is required.');
  return {
    list: (input = {}) => command({ ...input, action: 'list' }),
    create: input => command({ ...input, action: 'create' }),
    read: (id, options = {}) => command({ ...options, id, action: 'read' }),
    rename: input => command({ ...input, action: 'rename' }),
    archive: input => command({ ...input, action: 'archive' }),
    delete: input => command({ ...input, action: 'delete' }),
    restore: input => command({ ...input, action: 'restore' }),
    records: input => command({ ...input, action: 'records' }),
    resolve: input => command({ ...input, action: 'resolve' }),
    view: input => command({ ...input, action: 'view' }),
    search: input => command({ ...input, action: 'search' }),
  };
}

export async function handleDatabaseRequest(databases, request) {
  const url = new URL(request.url);
  if (url.pathname !== '/databases') return null;
  try {
    if (request.method === 'GET') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return Response.json(await databases.list({ before: url.searchParams.get('before') || undefined, limit, deleted: url.searchParams.get('deleted') === 'true' }));
    }
    if (request.method !== 'POST') throw fail('Use GET to read databases or POST to change them.', 405);
    const { action, ...input } = await readBoundedJson(request, 2_000_000, fail('Database request is too large. Send fewer records at once.', 413));
    if (!Object.hasOwn(databases, action) || action === 'list') throw fail('Unknown database action.');
    return Response.json(await (action === 'read' ? databases.read(input.id) : databases[action](input)));
  } catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 400 }); }
}

export const databaseTools = call => [
  { name: 'manage_databases', description: 'Create, read, rename, archive, restore or delete one of your databases. Each database keeps its own tables and records. Deleted databases can be restored.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create','read','rename','archive','restore','delete'] }, id: { type: 'string' }, name: { type: 'string' } }, required: ['action'] }, run: input => call('/databases', input) },
  { name: 'read_databases', description: 'Read a page of your databases.', inputSchema: { type: 'object', properties: { before: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, deleted: { type: 'boolean' } } }, run: input => call(`/databases?${new URLSearchParams(input ?? {})}`) },
  { name: 'database_records', description: 'Read, save, remove, import or export records in one of your databases. To remove a record, write it with value null. Read typed rows, schema, dated schema changes, historical records or the model. A write returns the saved records.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Database id' }, action: { type: 'string', enum: ['read','write','rows','schema','schema-history','history','model','find','import','export','backfill'] }, records: { type: 'array', items: { type: 'object' } }, type: { type: 'string' }, after: { type: ['string','integer'] }, before: { type: 'string' }, record: { type: 'string' }, words: { type: 'string' }, limit: { type: 'integer' }, valid: { type: 'string' }, known: { type: 'string' } }, required: ['id','action'] }, run: ({ action, record, ...input }) => call('/databases', { ...input, action: 'records', ...(record ? { record } : {}), record_action: action }) },
  { name: 'search_databases', description: 'Search records across selected databases, resolve a link naming a database and record, or view one kind\'s rows across databases (view: type, optional where of field values; own is your own store). Only your own databases can be read.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['search','resolve','view'] }, type: { type: 'string' }, where: { type: 'object' }, databases: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 }, database: { type: 'string' }, record: { type: 'string' }, words: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, resume: { type: 'object' } }, required: ['action'] }, run: input => call('/databases', input) },
];

export const databaseAnnotations = {
  manage_databases: { title: 'Manage my databases', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  read_databases: { title: 'Read my databases', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  database_records: { title: 'Use my database records', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  search_databases: { title: 'Search my databases', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
