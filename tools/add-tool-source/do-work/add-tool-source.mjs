// tools/add-tool-source/do-work/add-tool-source.mjs
//
// Purpose: Add a source of tools from one address (tool:add-tool-source). A source is a folder, a git repository at any host or a
// remote MCP server, and its kind is a stored fact this tool learns once and writes down with how it learned it: the person never
// types a kind. The owner's decision case source:a2VlcC1vbmx5LWJyaWFucy1kYXRhLWFuZC13aXBlLXRoZS1ib3hlcy0yMDI2LTExLTE2 (tool sources
// of any kind) fixes the order: the address's own syntax first (an explicit prefix, a path, a listed git host), then, only for a bare
// https address, one probe: an MCP `initialize`, else a git `info/refs`, else a refusal that names both.
//
//   addToolSource(input, { door, fetch })   input { address, label? } -> { source, entry, approve, said }; the one export the row runs.
//                                           `fetch` is the web's fetch, a test gives its own.
//
// What it makes is the entry the engine reads (trillion-rust src/tool_runs/tools/sources.rs `merge`) and the row of the person's list
// that holds it. It does not add the source: the engine's tools:add-source is the person's own act at the door, and `approve` is
// the call it hands back for the person to make. A source starts with an empty grant.
//
// Non-Negotiable Invariants:
// - Nothing is guessed: an address is a folder, a repository or a server by its syntax or by what it answered, and one that is
//   none of them, or both, is refused in one plain line that says what to write instead.
// - The probe is only for a bare https address, sends no credential, follows at most `max_redirects` redirects each to https, and
//   reads at most `max_bytes` of an answer. Where it may go is the run's own egress (a private address is refused there); a server
//   of the person's own at a private address is added only when the person wrote it as mcp+http://.
// - An address with a user name or password in it is refused; no secret is ever kept in a source.
// - A repository starts at the commit its server named as HEAD now, never at a moving branch.
//
// Security Considerations: the row's rights read and write the one record kind and prefix of the list of tool sources, nothing
// else; the engine, not this tool, adds the source, and only on the person's fresh sign-in.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/add-tool-source.json' with { type: 'json' };

const { probe, row, words } = data;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const refuse = (key, values = {}) => { throw new Error(fill(words[key], values)); };
const LABEL = new RegExp(data.label.allowed);

function labelOf(chosen, derived) {
  const label = chosen ?? derived.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, data.label.most_length);
  if (typeof label !== 'string' || !LABEL.test(label) || label.length > data.label.most_length) refuse('bad_label');
  return label;
}

function parsed(address) {
  let url;
  try { url = new URL(address); } catch { return refuse('bad_address'); }
  if (url.username || url.password) refuse('credentials_in_address');
  return url;
}

/** A folder: `/path`, `~/path` or `file:///path`, with no parent step in it. */
function folderEntry(path, chosen) {
  const home = path.startsWith('~/');
  const inside = home ? path.slice(2) : path;
  if (!inside || inside.split('/').includes('..')) refuse('bad_address');
  const name = inside.split('/').filter(Boolean).pop() ?? '';
  const place = home ? { home: inside.replace(/\/+$/, '') } : { at: inside.replace(/(.)\/+$/, '$1') };
  return { label: labelOf(chosen, name), kind: 'folder', place };
}

function remoteEntry(address, chosen, named) {
  const url = parsed(address);
  const entry = { label: labelOf(chosen, url.hostname.replace(/^www\./, '')), kind: 'remote-mcp', remote: { url: url.href } };
  if (url.protocol === 'http:') {
    if (!named) refuse('no_http');
    entry.remote.private_targets = [{ host: url.hostname, port: Number(url.port || 80) }];
  }
  return entry;
}

/** The repository's name as `owner/name` (any number of groups), from an https address. */
function repositoryOf(url) {
  const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (repository.split('/').length < 2 || repository.split('/').some(part => !part)) refuse('not_a_repository', { address: url.href });
  return repository;
}

function repoEntry(url, chosen, commit) {
  const host = data.repo_hosts[url.hostname];
  if (!host) refuse('unknown_archive', { host: url.hostname, known: Object.keys(data.repo_hosts).join(', ') });
  const repository = repositoryOf(url);
  return { label: labelOf(chosen, repository.split('/').pop()), kind: 'repo', repository, first_start_commit: commit, archive: host.archive, source_hosts: host.hosts };
}

/** One request, bounded, with no credential, following at most `max_redirects` redirects each to https. */
async function ask(send, address, init) {
  let at = address;
  for (let followed = 0; ; followed += 1) {
    const reply = await send(at, { ...init, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(probe.timeout_ms) });
    const next = [301, 302, 303, 307, 308].includes(reply.status) ? reply.headers.get('location') : null;
    if (!next) return reply;
    if (followed >= probe.max_redirects) throw new Error('followed too many redirects');
    at = new URL(next, at);
    if (at.protocol !== 'https:') throw new Error('was sent to an address that is not https');
    at = at.href;
  }
}

/** At most `max_bytes` of the answer's body, as text. */
async function read(reply) {
  const chunks = [];
  let length = 0;
  for await (const chunk of reply.body ?? []) {
    chunks.push(chunk);
    length += chunk.length;
    if (length >= probe.max_bytes) break;
  }
  return Buffer.concat(chunks).subarray(0, probe.max_bytes).toString('latin1');
}

function initializes(text) {
  const bodies = text.trimStart().startsWith('{') ? [text] : text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5));
  return bodies.some(body => {
    try {
      const answer = JSON.parse(body);
      return answer?.jsonrpc === '2.0' && object(answer.result) && ('protocolVersion' in answer.result || 'serverInfo' in answer.result);
    } catch { return false; }
  });
}

/** Whether `address` answers an MCP `initialize`: { is, why }. A 401 that points to its protected-resource metadata is a server asking for sign-in. */
async function asksMcp(send, address) {
  try {
    const reply = await ask(send, address, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: probe.protocol_version, capabilities: {}, clientInfo: { name: probe.client_name, version: probe.client_version } } }),
    });
    if (reply.status === 401 && /resource_metadata=/i.test(reply.headers.get('www-authenticate') ?? '')) return { is: true };
    if (reply.status !== 200) return { is: false, why: `it answered ${reply.status}` };
    return initializes(await read(reply)) ? { is: true } : { is: false, why: 'its answer was not an initialize answer' };
  } catch (error) {
    return { is: false, why: `it ${error.name === 'TimeoutError' ? 'did not answer in time' : error.message}` };
  }
}

/** Whether `address` answers a git ref advertisement, and the commit it names as HEAD: { is, commit, why }. */
async function asksGit(send, address) {
  try {
    const reply = await ask(send, `${address.replace(/\/+$/, '')}${probe.git_refs}`, { method: 'GET', headers: { accept: 'application/x-git-upload-pack-advertisement' } });
    if (reply.status !== 200) return { is: false, why: `it answered ${reply.status}` };
    const text = await read(reply);
    if (!text.slice(0, 64).includes(probe.git_advertisement)) return { is: false, why: 'its answer was not a ref advertisement' };
    return { is: true, commit: /([0-9a-f]{40}) HEAD/.exec(text)?.[1] };
  } catch (error) {
    return { is: false, why: `it ${error.name === 'TimeoutError' ? 'did not answer in time' : error.message}` };
  }
}

/** The entry and how its kind was learned, from the address alone or, for a bare https address, from one probe. */
async function learn(address, chosen, send) {
  if (/^(ssh:\/\/|git@|git:\/\/)/.test(address)) refuse('no_ssh');
  const prefix = data.prefixes.find(rule => address.startsWith(rule.starts));
  if (prefix) {
    const rest = prefix.strip ? address.slice(prefix.strip.length) : address;
    if (prefix.kind === 'folder') return { entry: folderEntry(rest, chosen), learned: 'syntax' };
    if (prefix.kind === 'remote-mcp') return { entry: remoteEntry(rest, chosen, prefix.private === true), learned: 'syntax' };
    return { entry: await repoFrom(parsed(rest), chosen, send), learned: 'syntax' };
  }
  if (!address.startsWith('https://')) refuse(address.startsWith('http://') ? 'no_http' : 'bad_address');
  const url = parsed(address);
  if (data.repo_hosts[url.hostname]) return { entry: await repoFrom(url, chosen, send), learned: 'syntax' };
  if (url.pathname.endsWith('.git')) return { entry: await repoFrom(url, chosen, send), learned: 'syntax' };
  const [mcp, git] = await Promise.all([asksMcp(send, url.href), asksGit(send, url.href)]);
  if (mcp.is && git.is) refuse('ambiguous', { address });
  if (mcp.is) return { entry: remoteEntry(url.href, chosen, false), learned: 'probe' };
  if (git.is) return { entry: repoEntry(url, chosen, git.commit ?? refuse('no_commit', { address })), learned: 'probe' };
  return refuse('neither', { address, mcp: mcp.why, git: git.why });
}

/** A repository entry: starts at the commit its server names as HEAD now. */
async function repoFrom(url, chosen, send) {
  if (!data.repo_hosts[url.hostname]) refuse('unknown_archive', { host: url.hostname, known: Object.keys(data.repo_hosts).join(', ') });
  const git = await asksGit(send, url.href);
  if (!git.is) throw new Error(fill(words.neither, { address: url.href, mcp: 'it was written as a git repository', git: git.why }));
  return repoEntry(url, chosen, git.commit ?? refuse('no_commit', { address: url.href }));
}

export async function addToolSource(input = {}, { door, fetch: send = globalThis.fetch } = {}) {
  if (!object(input)) throw new Error(words.no_address);
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  if (!address) refuse('no_address');
  if (address.length > 2048 || /[\s\u0000-\u001f]/.test(address)) refuse('bad_address');
  if (input.label !== undefined && typeof input.label !== 'string') refuse('bad_label');
  const { entry, learned } = await learn(address, input.label, send);
  for await (const held of door.list({ type: row.kind, prefix: row.prefix })) {
    if (held.value?.label === entry.label) refuse('taken', { label: entry.label });
  }
  const id = `${row.prefix}${entry.label}`;
  await door.write([{ id, type: row.kind, value: { label: entry.label, address, kind: entry.kind, learned, entry, status: row.waiting } }], { key: `add-tool-source:${entry.label}:${learned}` });
  const said = fill(words.added, { label: entry.label, kind: entry.kind, learned: learned === 'probe' ? 'it answered as one' : 'by its address' });
  return {
    source: { label: entry.label, kind: entry.kind, learned, row: id },
    entry,
    approve: { address: data.approve.address, method: data.approve.method, input: { entry, learned } },
    said: entry.kind === 'folder' ? `${said} ${words.folder_note}` : said,
  };
}
