// The same versioned configuration owner serves the Marketplace screen and the
// person's AI. Search words are interpreted by the connected AI; these calls
// only read or change the already selected records.
const component = { type: 'object', required: ['kind', 'id'], additionalProperties: false,
  properties: { kind: { type: 'string', description: 'Published Marketplace kind, such as tool or workflow' },
    id: { type: 'string', description: 'The published item id' } } };
const configuration = { slug: { type: 'string', description: 'Readable link name' },
  title: { type: 'string' }, description: { type: 'string' },
  components: { type: 'array', minItems: 1, maxItems: 100, items: component,
    description: 'Published tools, workflows or apps to install together' } };

export const marketplaceConfigurationTools = call => [
  { name: 'list_replacement_sets', description: 'Find published Marketplace replacement sets by plain words. The connected AI interprets the job; Trillion only matches listing text and returns versioned public records.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    run: ({ q = '', offset = 0, limit = 60 }) => call(`/marketplace/configurations?q=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}`) },
  { name: 'publish_replacement_set', description: 'Publish one versioned Marketplace set of published tools, workflows and apps. It gets a public page and one install action.',
    inputSchema: { type: 'object', required: ['slug', 'title', 'description', 'components'], properties: configuration },
    run: input => call('/marketplace/configurations/publish', input) },
  { name: 'revise_replacement_set', description: 'Publish a new version of a set you made and withdraw its prior listing; installed versions remain pinned. Repeating the same revision is safe.',
    inputSchema: { type: 'object', required: ['prior_id', 'slug', 'title', 'description', 'components'], properties: { prior_id: { type: 'string' }, ...configuration } },
    run: input => call('/marketplace/configurations/revise', input) },
  { name: 'withdraw_replacement_set', description: 'Withdraw a Marketplace set you made. Existing account installations can still be removed.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: input => call('/marketplace/configurations/withdraw', input) },
  { name: 'install_replacement_set', description: 'Install every pinned item in one published set into this account, pursuit or Space. The owner checks access to the chosen destination. Repeating an install is safe.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, context: { type: 'string', description: 'private, pursuit:<id>, or space:<id>; defaults to private' } } },
    run: input => call('/marketplace/configurations/install', input) },
  { name: 'list_replacement_set_installations', description: 'Read this account’s current Marketplace set installations, including their pinned versions and destinations. Continue using next until complete, including after an empty page.',
    inputSchema: { type: 'object', properties: {cursor:{type:'string'},limit:{type:'integer',minimum:1,maximum:64},configuration_id:{type:'string'}} },
    run: ({cursor,limit=32,configuration_id}={}) => call(`/marketplace/configurations/installations?limit=${limit}${cursor===undefined?'':`&cursor=${encodeURIComponent(cursor)}`}${configuration_id===undefined?'':`&configuration_id=${encodeURIComponent(configuration_id)}`}`) },
  { name: 'uninstall_replacement_set', description: 'Remove a Marketplace set installation from this account or a Space. For a Space provide its space_id and space_item_id; otherwise provide installation_id. Public apps are taken offline first, and shared Space tool grants remain until their last set is removed.',
    inputSchema: { type: 'object', properties: { installation_id: { type: 'string' }, space_id: { type: 'string' }, space_item_id: { type: 'string' } } },
    run: input => call('/marketplace/configurations/uninstall', input) },
];

export const marketplaceConfigurationAnnotations = {
  list_replacement_sets: { title: 'Find replacement sets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  publish_replacement_set: { title: 'Publish a replacement set', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  revise_replacement_set: { title: 'Revise a replacement set', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  withdraw_replacement_set: { title: 'Withdraw a replacement set', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  install_replacement_set: { title: 'Install a replacement set', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_replacement_set_installations: { title: 'List installed replacement sets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  uninstall_replacement_set: { title: 'Remove a replacement set', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
