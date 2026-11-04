// AI and human editor calls share the connected repository and revision checks.
import { pictureChange } from '../../../picture-a-code-change/src/change-picture.mjs';
import picture from '../../../picture-a-code-change/src/change-picture.json' with { type: 'json' };
const project = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const commit = { type: 'string', pattern: '^[0-9a-f]{40}$' };
const revision = { type: 'string', pattern: '^1f:[a-f0-9]{64}$' };
const address = id => `/source-projects/${id}`;
const siteLink = id => `/source-projects/site-link?installation_id=${encodeURIComponent(id)}`;

/** Runs one operation of the person's code-host connection (a Workshop tool) and answers its checked output. */
const connectorRunner = call => async (tool_id, input) => {
  let answer = await call('/tools/run', { tool_id, input, request_key: `picture-change:${crypto.randomUUID()}`, wait_seconds: 50, job: 'Read or write the change picture' });
  for (let attempt = 0; attempt < 10 && answer?.state === 'working' && answer.task_id; attempt += 1) {
    await new Promise(done => setTimeout(done, 3000));
    answer = await call(`/tasks/${encodeURIComponent(answer.task_id)}`);
  }
  if (answer?.state !== 'completed') throw new Error(answer?.error ?? `The code host did not complete ${tool_id} (${answer?.state ?? 'no answer'}).`);
  return answer.output;
};

export const sourceProjectTools = call => [
  { name: 'read_site_source_origin', description: 'Read the saved repository origin of a site you can access.',
    inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: project } },
    run: ({ installation_id }) => call(`/public-app/installations/${installation_id}/project/source-origin`) },
  { name: 'disconnect_site_source_origin', description: 'Disconnect a site from its saved repository origin while keeping its installed files and saved versions. Pass the exact project_origin returned by read_site_source_origin. Other saved assemblies and Worker attachments keep their own source connections.',
    inputSchema: { type: 'object', required: ['installation_id', 'expected_project_origin'], properties: {
      installation_id: project, expected_project_origin: { type: ['object', 'null'] },
    } }, run: ({ installation_id, expected_project_origin }) => call(`/public-app/installations/${installation_id}/project/source-origin`, { expected_project_origin }, 'DELETE') },
  { name: 'read_site_source_connection', description: 'Read the saved repository connection linked to a site you own.',
    inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: project } },
    run: ({ installation_id }) => call(siteLink(installation_id)) },
  { name: 'link_site_source_connection', description: 'Link a saved GitHub repository connection to a site you own. Pass its currently linked source project id, or null when no repository is linked.',
    inputSchema: { type: 'object', required: ['installation_id', 'source_project_id', 'expected_source_project_id'], properties: {
      installation_id: project, source_project_id: project, expected_source_project_id: { ...project, type: ['string', 'null'] },
    } }, run: ({ installation_id, ...input }) => call(siteLink(installation_id), input, 'PUT') },
  { name: 'unlink_site_source_connection', description: 'Disconnect the repository linked to a site you own. This keeps the saved repository connection and existing site files. Pass its currently linked source project id, or null after an earlier removal.',
    inputSchema: { type: 'object', required: ['installation_id', 'expected_source_project_id'], properties: {
      installation_id: project, expected_source_project_id: { ...project, type: ['string', 'null'] },
    } }, run: ({ installation_id, expected_source_project_id }) => call(siteLink(installation_id), { expected_source_project_id }, 'DELETE') },
  { name: 'list_source_projects', description: 'List original GitHub source projects connected to this Trillion account.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
    run: ({ cursor } = {}) => call(`/source-projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`) },
  { name: 'connect_source_project', description: 'Connect a GitHub repository and exact branch this account can read, or reuse one of its saved connections. Repeating the same connection refreshes its commit without making a duplicate. If several saved connections match, pass the project_id to keep, its expected_commit, and the current_commit returned by the conflict. This uses the existing sealed GitHub connection; it does not publish or copy the app backend.',
    inputSchema: { type: 'object', required: ['owner', 'repo', 'branch'], properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
      preview_url: { type: 'string', format: 'uri' }, live_url: { type: 'string', format: 'uri' },
      project_id: project, expected_commit: commit, current_commit: commit,
    } }, run: input => call('/source-projects', input) },
  { name: 'read_source_project', description: 'Read a connected source project and its current branch commit. A stale connection is reported when the branch has changed.',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: project } },
    run: ({ project_id }) => call(address(project_id)) },
  { name: 'remove_source_project', description: 'Remove this account’s saved connection to an original GitHub source. This keeps GitHub repositories, commits, source edit history and installed site files. The connection cannot be removed while a saved site link or assembly still uses it. Use the current revision from list_source_projects; retries after successful removal are safe.',
    inputSchema: { type: 'object', required: ['project_id', 'expected_revision'], properties: {
      project_id: project, expected_revision: revision,
    } }, run: ({ project_id, expected_revision }) => call(address(project_id), { expected_revision }, 'DELETE') },
  { name: 'configure_source_project', description: 'Set or clear the running preview and live HTTPS addresses on a connected original-source project. If its branch moved, pass the pinned expected_commit and the exact current_commit to refresh the same connection. The preview deployment revision is still checked separately.',
    inputSchema: { type: 'object', required: ['project_id', 'expected_commit'], properties: {
      project_id: project, expected_commit: commit, current_commit: commit,
      preview_url: { type: ['string', 'null'], format: 'uri' }, live_url: { type: ['string', 'null'], format: 'uri' },
    } }, run: ({ project_id, ...input }) => call(address(project_id), input, 'PATCH') },
  { name: 'resolve_source_selection', description: 'Confirm a selected element on the connected running preview, then map its evidence to one source location at the exact branch commit. The preview deployment revision is reported separately and may be unverified. When source ownership cannot be proved, returns a bounded list of possible files for inspection without an editable locator.',
    inputSchema: { type: 'object', required: ['project_id', 'expected_commit', 'selection'], properties: {
      project_id: project, expected_commit: commit, selection: { type: 'object' },
    } }, run: ({ project_id, expected_commit, selection }) => call(`${address(project_id)}/resolve`, { expected_commit, selection }) },
  { name: 'edit_source_project', description: 'Apply one supported visual edit to the verified original source file at its exact revision: literal text, an existing inline style value, or an existing safe link, local image path, or class value. Attribute edits never add new attributes or executable values. Returns the committed source and verification state; a build or live deployment is never inferred from the commit.',
    inputSchema: { type: 'object', required: ['project_id', 'expected_commit', 'selection', 'locator', 'intent'], properties: {
      project_id: project, expected_commit: commit, selection: { type: 'object' }, locator: { type: 'object' }, intent: { type: 'object' },
    } }, run: ({ project_id, expected_commit, selection, locator, intent }) => call(`${address(project_id)}/edit`, { expected_commit, selection, locator, intent }) },
  { name: 'picture_a_change', description: 'Draws what a change touched, between two points (base and head: commits, branches or tags) of a repository the account\'s code-host connection can read: one lane per folder, one node per file, each marked added, changed or removed. Answers the picture (a standalone image file per palette, with its identity), the exact list of what a model would be shown if it were asked for a richer picture (nothing is sent to one here), and the comment written for the code host\'s comment surface, with what it had to leave out and which of its abilities nobody has confirmed. document (optional) is a graph document you wrote from that list; it replaces the plain one after the graph contract checks it. post true also keeps ONE comment of ours on the pull request issue_number, found by its hidden marker and its author, never written twice and not written if the change moved on while it was made; image_url is where the picture is hosted for that comment. Without post it writes nothing.', inputSchema: { type: 'object', required: ['owner', 'repo', 'base', 'head'], properties: {
      forge: { type: 'string', description: `The code host (default ${picture.default_forge}); one of: ${Object.keys(picture.forges).join(', ')}` }, owner: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
      issue_number: { type: 'integer', minimum: 1 }, document: { type: 'object' }, image_url: { type: 'string' }, dark_image_url: { type: 'string' }, post: { type: 'boolean' },
    } }, run: input => pictureChange({ ...input, run: connectorRunner(call) }) },
  { name: 'verify_source_project', description: 'Read the connected branch, GitHub build checks, and selected rendered value for a source commit. A matching value is partial evidence until the deployment commit, comparable visuals, and backend behavior are independently proved.',
    inputSchema: { type: 'object', required: ['project_id', 'commit'], properties: { project_id: project, commit } },
    run: ({ project_id, commit: revision }) => call(`${address(project_id)}/verify`, { commit: revision }) },
];

export const sourceProjectAnnotations = {
  read_site_source_origin: { title: 'Read site repository origin', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  disconnect_site_source_origin: { title: 'Disconnect site repository origin', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  read_site_source_connection: { title: 'Read site repository connection', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  link_site_source_connection: { title: 'Link site repository connection', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  unlink_site_source_connection: { title: 'Disconnect site repository', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_source_projects: { title: 'List source projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  connect_source_project: { title: 'Connect original source', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  read_source_project: { title: 'Read source project revision', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  remove_source_project: { title: 'Remove saved source connection', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  configure_source_project: { title: 'Set source preview address', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  resolve_source_selection: { title: 'Find selected element in source', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  edit_source_project: { title: 'Edit original source', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  picture_a_change: { title: 'Picture a code change', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  verify_source_project: { title: 'Check source project build', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};
