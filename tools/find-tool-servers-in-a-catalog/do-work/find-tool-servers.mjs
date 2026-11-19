// tools/find-tool-servers-in-a-catalog/do-work/find-tool-servers.mjs
//
// The container tool `tool:find-tool-servers-in-a-catalog` (tool-rows.json): the tool servers a published catalog lists
// for some words, each with the `address` a call names to see and run its tools (tools:list / tools:run { address }).
// The catalog is data: read-data/catalogs.json names the default (the MCP registry's own list) and the shape it answers;
// a call may name another catalog that speaks the same API. Nothing is kept: the catalog is read as it is now.
//
// Words: a server is listed when every word is in its name, title or description (any case), as tools:list's `words`.
// The catalog's own search matches one text against names, so each word is asked of the catalog (its first page of the
// most it gives) and the servers holding every word are kept; one word pages with the catalog's own cursor.
// Input (standard input, JSON): { words, catalog?, limit?, cursor? }.
// Output: { servers: [{ name, title, description, status, address, transport, asks_for, repository, website, version }],
//           next_cursor }. `address` is null for a server the catalog lists with no remote (it runs only as a local
//           program); `asks_for` names the headers the server says a call must carry (a key the person connects first).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/catalogs.json', import.meta.url), 'utf8'));

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

// One catalog entry as the caller reads it.
export function serverOf(entry) {
  const server = entry?.server ?? {};
  const official = entry?._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
    .filter(remote => SETTINGS.remote_types.includes(remote?.type) && /^https:\/\//.test(remote?.url ?? ''));
  const remote = SETTINGS.remote_types.map(type => remotes.find(found => found.type === type)).find(Boolean) ?? null;
  return {
    name: String(server.name ?? ''),
    title: text(server.title) ?? text(server._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.title),
    description: text(server.description),
    status: text(official.status) ?? 'active',
    address: remote ? remote.url : null,
    transport: remote ? remote.type : null,
    asks_for: (remote?.headers ?? []).map(header => text(header?.name)).filter(Boolean),
    repository: text(server.repository?.url),
    website: text(server.websiteUrl),
    version: text(server.version),
  };
}

export async function findToolServers(input, { fetchImpl = fetch } = {}) {
  const words = text(input?.words);
  if (!words) throw new Error('Name the words to look for, like "email inboxes".');
  const catalog = text(input?.catalog) ?? SETTINGS.default_catalog;
  if (!/^https:\/\//.test(catalog)) throw new Error('A catalog is named by its https address.');
  const limit = input?.limit ?? SETTINGS.limit.default;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SETTINGS.limit.most) throw new Error(`Ask for 1 to ${SETTINGS.limit.most} servers at a time.`);
  const each = words.toLowerCase().split(/\s+/).filter(Boolean);
  const ask = async (word, size, cursor) => {
    const url = new URL(catalog);
    url.searchParams.set('search', word);
    url.searchParams.set('limit', String(size));
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`The catalog at ${url.origin} answered ${response.status}. Try again later.`);
    const body = await response.json();
    if (!Array.isArray(body?.servers)) throw new Error(`The catalog at ${url.origin} did not answer a list of servers.`);
    return { servers: body.servers.map(serverOf).filter(server => server.name), next: text(body.metadata?.nextCursor) };
  };
  let servers;
  let next = null;
  if (each.length === 1) {
    ({ servers, next } = await ask(each[0], limit, text(input?.cursor)));
  } else {
    const seen = new Map();
    for (const word of each) for (const server of (await ask(word, SETTINGS.limit.most)).servers) seen.set(server.name, server);
    const holds = server => { const all = [server.name, server.title, server.description].filter(Boolean).join(' ').toLowerCase(); return each.every(word => all.includes(word)); };
    servers = [...seen.values()].filter(holds);
  }
  // Active servers first, each group in the catalog's own order.
  servers.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
  return { servers: servers.slice(0, limit), next_cursor: next };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await findToolServers(JSON.parse(readFileSync(0, 'utf8') || '{}'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
