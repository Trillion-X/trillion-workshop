// src/connector-screen.mjs
// Owned by the account-screens builder (the signed-in guide screens).
//
// PURPOSE
//   The "Find a connector" section of Connections, as guide DATA (parts/ui/show/coss/guide.tsx draws it): a search box,
//   then each connector the public catalogs answered with (src/connector-catalog.mjs): its name, what it does, where it
//   was found, and Use, which adds it to the person's account through the Workshop's add-a-tool-server tool.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the catalogs answered in this search: the count is the one they reported, said only when they reported
//      one, and a catalog that could not be reached is named with its reason, never left out quietly.
//   2. No catalog, vendor or address is named here; they come from the catalog rows and their answers.
//   3. Use appears only on a connector that connects over the web (it has a connect address); any other opens its page.
//   4. A connector that can be added says in words that it runs live and nothing is copied ahead of time
//      (src/connection-card-words.json `tool_server`).

import { TOOL_SERVER_WORDS } from '../../src/connection-card-words.mjs';

const count = value => Number(value).toLocaleString('en-US');
const inWords = labels => (labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0] ?? '');
const FIND = '/work/api/connectors/find';

function connectorRow(connector) {
  const page = connector.page_url ? [{ label: 'Open its page', tone: 'plain', icon: 'ExternalLink', icon_only: true, href: connector.page_url }] : [];
  return {
    id: connector.id,
    title: connector.name,
    detail: [connector.job, connector.connect_url ? TOOL_SERVER_WORDS : 'Runs on a computer, so it cannot be added from here'].filter(Boolean).join(' · ') || undefined,
    ...(connector.logo ? { logo: connector.logo } : {}),
    status: { label: connector.source.label, tone: 'quiet' },
    actions: connector.connect_url
      ? [{ label: 'Use', tone: 'quiet', busy_label: 'Adding', send: { path: '/work/api/connectors/use', body: { server: connector.connect_url, name: connector.name } } }, ...page]
      : page,
  };
}

/** The section for `connectors`: { catalogs: the catalogs' names, found: a search's answer, or null before one }. */
export function findAConnectorSection({ catalogs = [], found = null } = {}) {
  const reached = found?.sources.filter(source => source.reached) ?? [];
  const counted = reached.filter(source => source.total !== null);
  const uncounted = reached.filter(source => source.total === null).map(source => source.label);
  const summary = !found ? `Search ${inWords(catalogs)} for a service your AI can use, and add it here.`
    : !found.connectors.length ? (reached.length ? `Nothing in ${inWords(reached.map(source => source.label))} matches${found.text ? ` "${found.text}"` : ''}.` : 'No catalog could be reached. Try again in a minute.')
      : [
        counted.length ? `${count(found.total)} ${found.text ? 'match' : 'connectors'} in ${inWords(counted.map(source => source.label))}` : null,
        uncounted.length ? `${counted.length ? 'more in' : 'Connectors from'} ${inWords(uncounted)}` : null,
      ].filter(Boolean).join(', ') + '.';
  const missed = found?.sources.filter(source => !source.reached) ?? [];
  return {
    id: 'find-connector',
    heading: 'Find a service or tool',
    body: summary,
    rows: [
      {
        id: 'find-a-connector',
        title: found?.text ? `Results for "${found.text}"` : 'Search the catalogs',
        starts_open: true,
        fields: [{ name: 'find', label: 'What should it connect to?', secret: false, placeholder: found?.text || 'Notion, send email, read a website' }],
        actions: [{ label: 'Search', tone: 'primary', busy_label: 'Asking the catalogs', send: { path: FIND, with_fields: true } }],
      },
      ...(found?.connectors ?? []).map(connectorRow),
    ],
    ...(missed.length ? { note: missed.map(source => `Couldn't reach ${source.label}: ${source.reason}.`).join(' ') } : {}),
    ...(found?.next_page ? { actions: [{ label: 'Show more', tone: 'quiet', busy_label: 'Asking the catalogs', send: { path: FIND, body: { find: found.text, page: found.next_page } } }] } : {}),
  };
}
