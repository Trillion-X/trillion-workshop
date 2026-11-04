// An AI creates public apps and edits the same installation draft and version history as the visual editor.
import { applyPublicAppEditorCommands, checkedPublicAppEditorSource, requirePublicAppEditorRevision } from '../../edit-a-site-visually/src/public-app-editor-model.mjs';

const installation = { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'The public app installation id.' };
const revision = { type: 'string', description: 'The current revision returned by read_public_app_installation.' };
const address = id => `/public-app/installations/${id}`;
// Where a page shows something Trillion keeps current: a visitor action of this app drawn as a form (a sign-up, a
// waitlist, a question), or a published capability. A page marks the spot with <div data-trillion-placement="<id>">
// and loads /capabilities/runtime.js and /capabilities/runtime.css; the host draws the rest.
const placedCapabilities = description => ({ type: 'array', maxItems: 100, description, items: {
  type: 'object', required: ['id', 'page_path', 'access', 'capability'], additionalProperties: false, properties: {
    id: { type: 'string', description: 'The placement id the page names in data-trillion-placement.' },
    page_path: { type: 'string', description: 'The page it is on, like index.html.' },
    access: { type: 'string', enum: ['public', 'signed-in'], description: 'public for a visitor action.' },
    capability: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: {
      kind: { type: 'string', description: 'visitor-action for one of this app\'s actions.' }, id: { type: 'string', description: 'For visitor-action, the action id.' },
      version: { type: 'string', description: 'Left out for a visitor action, it is worked out from the action; a given version must be the current one.' },
      operation: { type: 'string', enum: ['open', 'run'] },
    } },
    presentation: { type: 'object', description: 'For a visitor action, the form\'s words: title, description, submit_label, done_message, and fields [{ id, label, from_page_address, multiline, repeatable, add_label, remove_label }]. from_page_address names a query parameter that fills the field hidden. On text fields, multiline:true gives a roomy text area; repeatable:true gives add/remove entries, sent as one canonical text value joined with newlines, with no fixed entry-count cap. Use one of multiline or repeatable, never with a hidden page-address field. add_label and remove_label optionally name the repeatable buttons (up to 80 characters). Existing wire limits remain 4,000 characters per text field including newline separators and 16,384 bytes per whole answer; over-limit values stay available to edit and are never truncated. For a published capability: { title, description, style: card | plain }.' },
  },
} });

export const publicAppTools = call => [
  { name: 'publish_public_app_definition', description: 'Publish the files and declared visitor actions for a reusable public app. Check that words, assets and any promised action are ready to share before publishing. Returns the version to install. A site already in your Trillion files (the site.json Copy a website leaves, or any { "files": { path: contents } } file) publishes by files_from, with no need to send its contents; files then only changes or adds paths.', inputSchema: { type: 'object', required: ['id', 'actions'], properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,79}$' },
    files: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'object', required: ['file'], properties: { file: { type: 'string', pattern: '^1f:[a-f0-9]{64}$', description: 'One of your files by identity (find_file, list_files), such as a picture or font.' } } }] }, description: 'File paths mapped to their contents; index.html is required unless files_from has it. Text files (html, css, js, json, svg, txt) as their words; pictures, fonts, audio, video and PDF as data:<type>;base64,<bytes>, or as { "file": "1f:..." } naming one of your files.' },
    files_from: { type: 'string', pattern: '^1f:[a-f0-9]{64}$', description: 'One of your files holding a whole site, { "files": { path: contents } }, by identity: read a file at a time, so a site of any size publishes.' },
    actions: { type: 'array', maxItems: 40, items: { type: 'object', required: ['id', 'record_kind', 'fields'], properties: {
      id: { type: 'string' }, record_kind: { type: 'string' }, fields: { type: 'array', maxItems: 40, items: { type: 'object', required: ['id', 'type'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['text', 'email', 'number', 'boolean', 'date'] }, required: { type: 'boolean' },
      } } },
    } } },
    placed_capabilities: placedCapabilities('Forms and published capabilities placed on the app\'s pages. A sign-up page is one action (say email and source fields), one placement { id, page_path, access: public, capability: { kind: visitor-action, id: <action id> }, presentation } and a page holding <div data-trillion-placement="<id>"></div>. Each installation serves a printable code for its address at /capabilities/address-code.svg?from=<place> (and &page=<page>), an SVG to keep with write_file from_url.'),
  } }, run: input => call('/public-app/definitions', input, 'POST') },
  { name: 'install_public_app', description: 'Install a published app version in this account or a Space you can add items to. Visitor records belong to the chosen place. context selects ownership, not public visibility. Set live:false to create it offline for authenticated editing without exposing its pages; the returned public address answers not-found until explicitly brought online.', inputSchema: { type: 'object', required: ['app_id', 'version', 'context'], properties: {
    app_id: { type: 'string' }, version: { type: 'string' }, context: { oneOf: [
      { type: 'string', const: 'private' },
      { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', const: 'space' }, id: { type: 'string' } } },
    ] }, installation_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Optional stable id for safe retries.' },
    name: { type: 'string', description: 'Optional readable name for its address, like field-notes (3 to 40 lowercase letters, numbers and hyphens). Left out, the app is named from its own page title, else two readable words.' },
    live: { type: 'boolean', description: 'Defaults to true. false installs offline; authenticated owners and permitted Space members can still edit and save drafts.' },
  } }, run: input => call('/public-app/installations', input, 'POST') },
  { name: 'name_public_app', description: 'Give an installed public app a new readable address name, like field-notes, served at https://<name>.<Trillion sites host>/. The earlier name keeps sending visitors on to the new one. Only the installer can rename it.', inputSchema: { type: 'object', required: ['installation_id', 'name'], properties: { installation_id: installation, name: { type: 'string', description: '3 to 40 lowercase letters, numbers and hyphens.' } } }, run: ({ installation_id, name }) => call(`${address(installation_id)}/name`, { name }, 'PUT') },
  { name: 'list_public_app_installations', description: 'List this account’s installed public apps, or those in a Space you belong to when space_id is given.', inputSchema: { type: 'object', properties: { space_id: { type: 'string', description: 'A Space id from list_pursuits.' } } }, run: ({ space_id }) => call(`/public-app/installations${space_id ? `?space_id=${encodeURIComponent(space_id)}` : ''}`) },
  { name: 'claim_public_app_domain', description: 'Start connecting a domain you control to one installed public app. Returns the DNS TXT record that proves control.', inputSchema: { type: 'object', required: ['installation_id', 'host'], properties: { installation_id: installation, host: { type: 'string', description: 'The domain name, without https:// or a path.' } } }, run: ({ installation_id, host }) => call(`${address(installation_id)}/domains`, { action: 'claim', host }, 'POST') },
  { name: 'activate_public_app_domain', description: 'Check domain ownership, require the hosting provider to confirm this exact hostname is attached to this app, then confirm its HTTPS address reaches the public app host. Activates only when every check agrees.', inputSchema: { type: 'object', required: ['installation_id', 'host'], properties: { installation_id: installation, host: { type: 'string' } } }, run: ({ installation_id, host }) => call(`${address(installation_id)}/domains`, { action: 'activate', host }, 'POST') },
  { name: 'retire_public_app_domain', description: 'Stop serving an installed public app from one connected domain, then retire it only after the hosting provider confirms it is detached.', inputSchema: { type: 'object', required: ['installation_id', 'host'], properties: { installation_id: installation, host: { type: 'string' } } }, run: ({ installation_id, host }) => call(`${address(installation_id)}/domains`, { host }, 'DELETE') },
  { name: 'read_public_app_installation', description: 'Read the live files, visitor actions, revision and AI-crawler setting (ai_crawlers) of an installed public app, plus any saved draft with its draft_url, and each earlier version with the address it opens at.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: async ({ installation_id }) => {
    const [current, saved, kept] = await Promise.all([call(address(installation_id)), call(`${address(installation_id)}/draft`), call(`${address(installation_id)}/versions`)]);
    return { ...current, draft: saved.draft, draft_url: saved.preview_url ?? null, versions: kept.versions, version_addresses: kept.addresses };
  } },
  { name: 'read_public_app_file', description: 'Read one file in an installed public app or its saved draft by path, such as features/index.html. The answer includes the current installation and draft revisions.', inputSchema: {
    type: 'object', required: ['installation_id', 'path'], properties: { installation_id: installation, path: { type: 'string' } },
  }, run: ({ installation_id, path }) => call(`${address(installation_id)}/file?path=${encodeURIComponent(path)}`) },
  { name: 'write_public_app_file', description: 'Add or replace one file in an installed public app draft. Use UTF-8 text for text files and data:<type>;base64,<bytes> for binary files. The change stays in the draft until publish_public_app_draft runs.', inputSchema: {
    type: 'object', required: ['installation_id', 'path', 'content', 'expected_revision', 'expected_draft_revision'], properties: {
      installation_id: installation, path: { type: 'string' }, content: { type: 'string' }, expected_revision: revision,
      expected_draft_revision: { type: ['string', 'null'] },
    },
  }, run: ({ installation_id, path, content, expected_revision, expected_draft_revision }) =>
    call(`${address(installation_id)}/file`, { path, content, expected_revision, expected_draft_revision }, 'PUT') },
  { name: 'delete_public_app_file', description: 'Remove one file from an installed public app draft by path. The change stays in the draft until publish_public_app_draft runs; index.html cannot be removed.', inputSchema: {
    type: 'object', required: ['installation_id', 'path', 'expected_revision', 'expected_draft_revision'], properties: {
      installation_id: installation, path: { type: 'string' }, expected_revision: revision,
      expected_draft_revision: { type: ['string', 'null'] },
    },
  }, run: ({ installation_id, path, expected_revision, expected_draft_revision }) =>
    call(`${address(installation_id)}/file`, { path, expected_revision, expected_draft_revision }, 'DELETE') },
  { name: 'read_public_app_project', description: 'Read the current app project for an installed site, including routes, files, source details, permissions, capabilities, and supported output status.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/project`) },
  { name: 'read_public_app_project_draft', description: 'Read the saved editable project for an installed site, including its routes, assets, behavior, capability placements, source details, and output status.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/project/draft`) },
  { name: 'read_public_app_project_assembly', description: 'Read the checked source snapshots for one installed app, including which source owns each route, asset, behavior and capability placement.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/project/assembly`) },
  { name: 'save_public_app_project_assembly', description: 'Save checked source snapshots for one installed app. Keep the installed site project snapshot as returned by read_public_app_project_assembly and keep its web target selected; add iPhone or Mac targets when the source supports them. Replace or add other source rows and send the current assembly revision. To import source files, pass source_files as source keys mapped to paths and file contents (text or exact blob references), along with the source-files revision returned by read_public_app_project_assembly.', inputSchema: { type: 'object', required: ['installation_id', 'expected_revision', 'project'], properties: {
    installation_id: installation,
    expected_revision: { type: 'string', description: 'The assembly revision returned by read_public_app_project_assembly.' },
    project: { type: 'object', description: 'A complete trillion.editable-app-project value returned or rebuilt from the checked project assembly.' },
    source_files: { type: 'object', description: 'Optional source-key → path → file values to create or replace imported source snapshots. File values are UTF-8 or valid data URL strings, or exact blob references returned by the file owner.', additionalProperties: { type: 'object', additionalProperties: { oneOf: [
      { type: 'string', description: 'UTF-8 text, or data:<media-type>;base64,<bytes> for binary files.' },
      { type: 'object', required: ['blob_ref', 'media_type', 'size'], additionalProperties: false, properties: {
        blob_ref: { type: 'string', description: 'The exact admitted blob reference.' },
        media_type: { type: 'string', description: 'The admitted blob media type.' },
        size: { type: 'integer', minimum: 0, description: 'The admitted blob size in bytes.' },
      } },
    ] } } },
    expected_source_files_revision: { type: 'string', description: 'The current source-files revision returned by read_public_app_project_assembly. Required when source_files is supplied.' },
  } }, run: ({ installation_id, expected_revision, project, source_files, expected_source_files_revision }) => call(`${address(installation_id)}/project/assembly`, {
    expected_revision, project,
    ...(source_files === undefined ? {} : { source_files }),
    ...(expected_source_files_revision === undefined ? {} : { expected_source_files_revision }),
  }, 'PUT') },
  { name: 'read_public_app_worker_backend', description: 'Read the Worker attached to one installed site, including its pinned source, enabled state and declared permissions. Only the installer can read this backend.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/backend`) },
  { name: 'detach_public_app_worker_backend', description: 'Detach the Worker from this installed site. The site pages and its SQLite database are kept. Only the installer can detach it. Repeating this action is safe; read back with read_public_app_worker_backend.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/backend`, {}, 'DELETE') },
  { name: 'set_public_app_worker_enabled', description: 'Enable or disable the Worker already attached to one installed site. This changes only whether the Worker receives traffic; its files, permissions and database stay as they are. Repeating the same state is safe. Read it back with read_public_app_worker_backend. Only the installer can change it.', inputSchema: { type: 'object', required: ['installation_id', 'enabled'], properties: { installation_id: installation, enabled: { type: 'boolean', description: 'true to enable the attached Worker, false to disable it.' } } }, run: ({ installation_id, enabled }) => call(`${address(installation_id)}/backend/enabled`, { enabled }, 'PUT') },
  { name: 'attach_public_app_worker_from_source', description: 'Attach a self-contained Worker module and declared asset/data files from one exact pinned GitHub source in the saved project assembly. The repository must contain trillion-site-worker.json; source-build-lock.json may pin sibling data inputs and paths. The manifest may declare outbound hosts, AI models, schedules, email senders and incoming mail. Sites reads only committed files and does not run repository scripts or install packages. Reattaching keeps this installation’s SQLite; unchanged permissions keep the enabled state, while a new permission takes the Worker offline until enabled. Email senders still require this account’s grant. A first attachment stays offline. Incoming mail needs a route handed to this site; Trillion sign-in is not exposed to this Worker.', inputSchema: { type: 'object', required: ['installation_id', 'source_key', 'expected_revision'], properties: {
    installation_id: installation, source_key: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$', description: 'The source row key from read_public_app_project_assembly.' },
    expected_revision: { type: 'string', description: 'The current assembly revision from read_public_app_project_assembly.' },
  } }, run: ({ installation_id, source_key, expected_revision }) => call(`${address(installation_id)}/backend/source`, { source_key, expected_revision }, 'POST') },
  { name: 'read_public_app_records', description: 'Read visitor responses saved for one installed public app in the account or Space you can access.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/records`) },
  { name: 'edit_public_app_draft', description: 'Save exact HTML or CSS text replacements, changes to one addressed element (every element on a page carries data-trillion-element), and declared visitor actions for an installed public app. The draft does not change the live page until publish_public_app_draft runs; it answers preview_url, the address of the draft itself to open or share before publishing.', inputSchema: {
    type: 'object', required: ['installation_id', 'expected_revision', 'commands'], properties: {
      installation_id: installation, expected_revision: { ...revision, description: 'The saved draft revision when one exists; otherwise the current installation revision returned by read_public_app_installation.' },
      commands: { type: 'array', maxItems: 50, items: { type: 'object', required: ['type', 'path'], properties: {
        type: { type: 'string', enum: ['replace-text', 'set-element'], description: 'replace-text: find and replace exact text. set-element: change the element whose data-trillion-element is `element` (every element on a page carries one).' },
        path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' },
        element: { type: 'string', description: 'set-element: the data-trillion-element address, like e1f.' },
        attributes: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'set-element: attributes to set; null removes one.' },
        text: { type: 'string', description: 'set-element: new words for an element that holds only words.' },
      } } },
      actions: { type: 'array', maxItems: 40, description: 'The complete visitor action list to declare for this installation.', items: {
        type: 'object', required: ['id', 'record_kind', 'fields'], properties: {
          id: { type: 'string' }, record_kind: { type: 'string' },
          fields: { type: 'array', maxItems: 40, items: { type: 'object', required: ['id', 'type'], properties: {
            id: { type: 'string' }, type: { type: 'string', enum: ['text', 'email', 'number', 'boolean', 'date'] }, required: { type: 'boolean' },
          } } },
        },
      } },
      placed_capabilities: placedCapabilities('The complete list of capabilities placed on public app pages.'),
    },
  }, run: async ({ installation_id, expected_revision, commands, actions, placed_capabilities }) => {
    if (!commands.length && actions === undefined && placed_capabilities === undefined) throw new Error('Choose a page change, visitor action, or page capability.');
    if (!commands.length) {
      // The editor preview is not the whole indexed site. Keep its file owner when only metadata changes.
      const current = await call(`${address(installation_id)}/file?path=index.html`);
      requirePublicAppEditorRevision(current.draft_revision ?? current.revision, expected_revision);
      return call(`${address(installation_id)}/file`, { path: 'index.html', expected_revision: current.revision, return_draft: true,
        expected_draft_revision: current.draft_revision ?? null,
        ...(actions === undefined ? {} : { actions }), ...(placed_capabilities === undefined ? {} : { placed_capabilities }) }, 'PUT');
    }
    const [current, saved] = await Promise.all([call(address(installation_id)), call(`${address(installation_id)}/draft`)]);
    const source = saved.draft ?? current;
    requirePublicAppEditorRevision(source.revision, expected_revision);
    const edited = checkedPublicAppEditorSource({
      ...(commands.length ? applyPublicAppEditorCommands(source, { commands, expectedRevision: expected_revision }) : source),
      ...(actions === undefined ? {} : { actions }),
      ...(placed_capabilities === undefined ? {} : { placed_capabilities }),
    });
    // The words put in are what an open editor shows this AI changing (src/board-room.mjs announce).
    const changed_words = commands.map(command => String(command.replace ?? command.text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
    // The element an edit named by its address, so an open editor outlines exactly that part as this AI's.
    const changed_element = commands.find(command => command.type === 'set-element' && typeof command.element === 'string')?.element;
    return call(`${address(installation_id)}/draft`, { ...edited, expected_revision: current.revision, expected_draft_revision: saved.draft?.revision ?? null, changed_words, ...(changed_element ? { changed_element } : {}) }, 'PUT');
  } },
  { name: 'refresh_public_app_route_from_source', description: 'Copy one page and its same-site static assets from the public website this installation was copied from into a checked file draft. This only adds or updates the chosen route and its route-scoped asset folder; other pages, visitor actions and the attached Worker stay in the draft unchanged. The saved draft is not live until publish_public_app_draft runs. Use a source route like /features/ and an installation path like features/index.html. Include the current installation revision and the current draft revision (null when there is no draft).', inputSchema: {
    type: 'object', required: ['installation_id', 'source_route', 'target_route', 'scope', 'expected_revision', 'expected_draft_revision'], properties: {
      installation_id: installation,
      source_route: { type: 'string', description: 'A route within this installation’s connected public source, such as /features/.' },
      target_route: { type: 'string', description: 'The file path that should serve the route, such as features/index.html.' },
      scope: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$', description: 'A stable short name for this route’s asset folder, such as features.' },
      expected_revision: revision,
      expected_draft_revision: { type: ['string', 'null'], description: 'The saved draft revision, or null when no draft exists.' },
    },
  }, run: ({ installation_id, source_route, target_route, scope, expected_revision, expected_draft_revision }) =>
    call(`${address(installation_id)}/route-refresh`, { source_route, target_route, scope, expected_revision, expected_draft_revision }, 'POST') },
  { name: 'publish_public_app_draft', description: 'Put a saved public app draft live at its existing link and keep the prior version for restore. The answer carries ai_readiness: the score and missing checks of the live home page for AI answer engines, a warning that never stops the publish.', inputSchema: { type: 'object', required: ['installation_id', 'expected_revision'], properties: { installation_id: installation, expected_revision: revision } }, run: ({ installation_id, expected_revision }) => call(`${address(installation_id)}/publish`, { expected_revision }) },
  { name: 'restore_public_app_version_to_draft', description: 'Put an earlier installed app version (revision from read_public_app_installation versions) back as the draft, leaving the live app as it is; publish_public_app_draft publishes it. warnings name every placed form or tool of that version whose page or tool is gone. expected_draft_revision (the draft revision you read, null for none) refuses it if the draft changed since.', inputSchema: { type: 'object', required: ['installation_id', 'revision', 'expected_revision'], properties: { installation_id: installation, revision, expected_revision: revision, expected_draft_revision: { type: ['string', 'null'] } } }, run: ({ installation_id, revision: earlier, ...rest }) => call(`${address(installation_id)}/restore-draft`, { revision: earlier, ...rest }) },
  { name: 'restore_public_app_version', description: 'Restore an earlier installed app version at the same live link. Each earlier version opens at its own address first (the addresses read_public_app_installation lists for its versions), so it can be seen before it is restored.', inputSchema: { type: 'object', required: ['installation_id', 'revision', 'expected_revision'], properties: { installation_id: installation, revision, expected_revision: revision } }, run: ({ installation_id, revision: earlier, expected_revision }) => call(`${address(installation_id)}/restore`, { revision: earlier, expected_revision }) },
  { name: 'take_public_app_offline', description: 'Take one installed public app offline. Its address, and any domain connected to it, then answer not-found; its visitor responses stay readable with read_public_app_records, and its name stays held so bring_public_app_back_online puts it back at the same address. release_name true also gives up its name (and earlier names) for any later app to take; only the person who installed it can. Taking an app that is already offline changes nothing. A Space app can be taken offline by any member the Space\'s rules let add items.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation, release_name: { type: 'boolean', description: 'Also give up its address name. Left out, the name stays held for this app.' } } }, run: ({ installation_id, release_name }) => call(`${address(installation_id)}/live`, { live: false, ...(release_name ? { release_name: true } : {}) }, 'PUT') },
  { name: 'bring_public_app_back_online', description: 'Put an installed public app that was taken offline back online at the same address, with any domain connected to it serving it again. If its name was given up, it takes that name again when still free, else a new one; the answer says its address. Bringing back an app that is already online changes nothing.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/live`, { live: true }, 'PUT') },
  { name: 'read_public_app_ai_readiness', description: 'Check how ready the live home page of one public app installation is for AI answer engines, read from the HTML it is served with (no script run): a score out of 100, each missing check with how to fix it, and suggestions that do not change the score. publish_public_app_draft answers the same check as ai_readiness.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation } }, run: ({ installation_id }) => call(`${address(installation_id)}/ai-readiness`) },
  { name: 'set_public_app_ai_crawlers', description: 'Choose whether AI and answer-engine crawlers (meta-webindexer, OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Claude-User) may read one public app. Apps are open to them by default; allow false adds a robots.txt that keeps them out while search engines still read the app. An app that has its own robots.txt file keeps that file, which always wins. Only the installer can change it. The answer says who decides now.', inputSchema: { type: 'object', required: ['installation_id', 'allow'], properties: { installation_id: installation, allow: { type: 'boolean' } } }, run: ({ installation_id, allow }) => call(`${address(installation_id)}/ai-crawlers`, { allow }, 'PUT') },
  { name: 'read_public_app_analytics', description: 'Read page views, visitors and successful submissions for one public app installation.', inputSchema: { type: 'object', required: ['installation_id'], properties: { installation_id: installation, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } }, run: ({ installation_id, from, to }) => call(`${address(installation_id)}/analytics${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ''}`) },
];

export const publicAppAnnotations = {
  publish_public_app_definition: { title: 'Publish a public app', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  install_public_app: { title: 'Install a public app', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  name_public_app: { title: 'Name a public app', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  list_public_app_installations: { title: 'List installed public apps', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  claim_public_app_domain: { title: 'Start connecting a domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  activate_public_app_domain: { title: 'Connect a verified domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  retire_public_app_domain: { title: 'Stop serving a domain', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  read_public_app_installation: { title: 'Read installed public app', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_public_app_file: { title: 'Read one installed app file', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write_public_app_file: { title: 'Save one installed app file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  delete_public_app_file: { title: 'Remove one installed app file', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  read_public_app_project: { title: 'Read installed app project', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_public_app_project_draft: { title: 'Read app project draft', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_public_app_project_assembly: { title: 'Read app source projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_public_app_project_assembly: { title: 'Save app source projects', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  read_public_app_worker_backend: { title: 'Read the site Worker backend', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  detach_public_app_worker_backend: { title: 'Detach the site Worker backend', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  set_public_app_worker_enabled: { title: 'Enable or disable the site Worker', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  attach_public_app_worker_from_source: { title: 'Attach a pinned Worker source', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_public_app_records: { title: 'Read public app responses', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  edit_public_app_draft: { title: 'Edit a public app draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  refresh_public_app_route_from_source: { title: 'Refresh one app page from its source', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  publish_public_app_draft: { title: 'Publish a public app draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  restore_public_app_version_to_draft: { title: 'Put a public app version back as the draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  restore_public_app_version: { title: 'Restore a public app version', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  take_public_app_offline: { title: 'Take a public app offline', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  bring_public_app_back_online: { title: 'Bring a public app back online', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_public_app_ai_readiness: { title: 'Check a public app for AI answer engines', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_public_app_ai_crawlers: { title: 'Allow or keep out AI crawlers', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_public_app_analytics: { title: 'Read public app analytics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
