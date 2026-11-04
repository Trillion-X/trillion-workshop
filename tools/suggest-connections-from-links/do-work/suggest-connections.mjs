// tools/suggest-connections-from-links/do-work/suggest-connections.mjs
//
// tool:suggest-connections-from-links. The row's request ({ text, tools, connected? }) handed to the moved
// providersForLinks (src/connection-links.mjs): each service a link in the words falls under, with the host that
// matched, leaving out the providers already connected. It only proposes: connecting stays the person's own step.
import { hostsIn, providersForLinks } from '../src/connection-links.mjs';

export function suggestConnections({ text, tools, connected = [] } = {}) {
  if (typeof text !== 'string') throw new Error('Give text: the words to read links from.');
  if (!Array.isArray(tools)) throw new Error('Give tools: the connection rows, each { id, invoke: { provider, connects: { domain } } }.');
  const found = providersForLinks(text, tools);
  const suggestions = [...found].filter(([provider]) => !connected.includes(provider)).map(([provider, host]) => ({ provider, host, reason: `Your work links to ${host}` }));
  return { hosts: hostsIn(text), suggestions };
}
