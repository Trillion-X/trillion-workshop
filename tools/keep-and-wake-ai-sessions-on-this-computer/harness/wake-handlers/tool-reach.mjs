// harness/wake-handlers/tool-reach.mjs
//
// Purpose
//   What a Marketplace tool run on this computer may reach, enforced by macOS rather than by this program. A tool's
//   descriptor declares `reach` ([{ kind, ... }]); this module checks its code is the code its maker saved (the files'
//   BLAKE3 fingerprint), checks the person allowed that reach for that exact code when the maker is not trusted, and
//   turns the declaration into a sandbox profile the command is started under (/usr/bin/sandbox-exec). Whatever the tool
//   did not declare (the person's files, other disks, the network, microphone, camera) the kernel refuses.
//
// Non-negotiable invariants
//   1. Code runs only when its bytes hash to the fingerprint the Workshop saved; there is no unverified road.
//   2. Every kind of reach is a row in tool-reach.json; this file names none of them.
//   3. A declared kind that is not a row, a row missing a value it needs, or a path holding a quote is refused, never
//      dropped: dropping it would run the tool with less than it says and hide why it failed.
//   4. Approval is for one tool, one files fingerprint and one reach: new code or wider reach asks again.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import settings from './tool-reach.json' with { type: 'json' };

export const fingerprintOf = bytes => `1f:${bytesToHex(blake3(bytes))}`;

const quoted = text => {
  if (/["\\\n]/.test(text)) throw new Error(`The path ${text} holds a character a sandbox rule cannot hold.`);
  return `"${text}"`;
};
const expand = (path, home) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);
// The sandbox matches the real path (/var is /private/var), so a place that exists is named by its real path; one that
// does not exist yet keeps its resolved path, and its real parent where that exists.
const real = path => {
  const full = resolve(path);
  try { return realpathSync(full); } catch { try { return join(realpathSync(dirname(full)), full.slice(dirname(full).length + 1)); } catch { return full; } }
};

/** The reach rows a descriptor declares, each checked against tool-reach.json `kinds`, with what the person is asked. */
export function declaredReach(descriptor, { home, rules = settings } = {}) {
  const reach = descriptor?.reach ?? [];
  if (!Array.isArray(reach)) throw new Error('reach is a list of { kind, ... } rows.');
  return reach.map(row => {
    const kind = rules.kinds[row?.kind];
    if (!kind) throw new Error(`This computer does not know the reach ${JSON.stringify(row?.kind)}. Known: ${Object.keys(rules.kinds).join(', ')}.`);
    const values = {};
    for (const name of kind.needs) {
      if (typeof row[name] !== 'string' && typeof row[name] !== 'number') throw new Error(`reach ${row.kind} needs ${name}.`);
      values[name] = name === 'path' ? real(expand(String(row[name]), home)) : String(row[name]);
    }
    if (values.port !== undefined && !/^\d{1,5}$/.test(values.port)) throw new Error(`reach ${row.kind} port must be a number.`);
    if (kind.pass_env && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(values[kind.pass_env])) throw new Error(`reach ${row.kind} ${kind.pass_env} must be a variable name.`);
    // A name the declaration does not carry (the proxy's port, known only when the run starts) is left for the run to fill.
    const fill = text => text.replace(/\{(\w+)\}/g, (whole, name) => (name === 'path' ? quoted(values.path).slice(1, -1) : name in values ? values[name] : whole));
    return { kind: row.kind, values, ...(kind.pass_env ? { pass_env: values[kind.pass_env] } : {}), asks: kind.asks, enforced: kind.enforced, allow: kind.allow.map(fill), env: kind.env ?? {}, proxy: kind.proxy ?? null, said: fill(kind.said) };
  });
}

// What a run may start. "open" adds no rule; "allowlist" starts nothing but the run's own folder, its interpreter, env, the
// named program and the rows of `exec.allow`.
const execLines = ({ folder, program, interpreter, rules }) => {
  if ((rules.exec?.mode ?? 'open') !== 'allowlist') return [];
  const places = [`(subpath ${quoted(real(folder))})`, '(literal "/usr/bin/env")', ...(interpreter ? [`(subpath ${quoted(interpreter)})`] : []),
    ...(program && program.startsWith('/') ? [`(literal ${quoted(real(program))})`] : []),
    ...rules.exec.allow.map(row => `(${row.match === 'subpath' ? 'subpath' : 'literal'} ${quoted(row.path)})`)];
  return ['(deny process-exec*)', `(allow process-exec ${places.join(' ')})`];
};

/** The programs and reach a run has, said from the rows that build its fence (so what is said is what is enforced). */
export function describeRun({ reach = [], rules = settings } = {}) {
  const allowlist = (rules.exec?.mode ?? 'open') === 'allowlist';
  return { programs: allowlist ? ['its own files', 'its interpreter', '/usr/bin/env', ...rules.exec.allow.map(row => row.path)] : 'any program',
    reach: reach.map(row => row.said) };
}

/** A command the argument rules refuse, as the words to say; null when none does. A rule off in the data refuses nothing. */
export function argumentRefusal(argv, { rules = settings } = {}) {
  const [program, ...args] = argv.map(String);
  const name = program.split('/').pop();
  for (const row of rules.argument_rules ?? []) {
    if (!row.enabled || (row.command !== '*' && row.command !== name)) continue;
    if (row.deny_regex && new RegExp(row.deny_regex).test(` ${args.join(' ')} `)) return row.message;
    if (row.flag) {
      for (let at = 0; at < args.length; at += 1) {
        const given = args[at] === row.flag ? args[at + 1] : args[at].startsWith(`${row.flag}=`) ? args[at].slice(row.flag.length + 1) : undefined;
        if (given !== undefined && !row.only_values.includes(given)) return row.message;
      }
    }
  }
  return null;
}

// Its own folder, everything the interpreter it starts needs (when that lives in a protected place), and what it declared.
export function sandboxProfile({ folder, reach, interpreter, home, program, rules = settings }) {
  const protectedPlaces = rules.protected_roots.map(root => `(subpath ${quoted(real(expand(root, home)))})`).join(' ');
  const interpreterRule = interpreter ? `(subpath ${quoted(interpreter)})` : '(literal "/dev/null")';
  const above = path => { const out = []; for (let at = dirname(path); at !== dirname(at); at = dirname(at)) out.push(at); return out; };
  const ancestors = [...new Set([real(folder), ...(interpreter ? [interpreter] : [])].flatMap(above))].map(path => `(literal ${quoted(path)})`).join(' ') || '(literal "/")';
  const base = rules.base.map(line => line.replace('{ancestors}', ancestors).replace('{protected}', protectedPlaces).replace('{folder}', quoted(real(folder)).slice(1, -1)).replace('{interpreter}', interpreterRule));
  return [...base, ...execLines({ folder, program, interpreter, rules }), ...reach.flatMap(row => row.allow)].join('\n');
}

// The install folder of the program argv[0] names, when it lives in a protected place (node under ~/.nvm): its whole
// version folder is readable so the program can load its own libraries.
export function interpreterRoot(command, { home, rules = settings, which = name => name }) {
  const path = command.includes('/') ? command : which(command);
  if (!path || !existsSync(path)) return null;
  const program = realpathSync(path);
  const roots = rules.protected_roots.map(root => real(expand(root, home)));
  if (!roots.some(root => program === root || program.startsWith(`${root}/`))) return null;
  return dirname(dirname(program));
}

const reachIdentity = reach => fingerprintOf(new TextEncoder().encode(JSON.stringify(reach.map(row => [row.kind, row.values]))));

/** Whether this run may start: the person allowed this reach for this tool's exact code, or its maker is trusted. */
export function approvalOf({ toolId, madeBy, fingerprint, reach, folder, rules = settings }) {
  const asking = reach.filter(row => row.asks);
  if (!asking.length || rules.trusted_makers.includes(madeBy)) return { approved: true };
  const identity = reachIdentity(reach);
  const file = join(folder, rules.approvals_file);
  let approvals = [];
  try { approvals = JSON.parse(readFileSync(file, 'utf8')).approvals ?? []; } catch {}
  if (approvals.some(row => row.tool_id === toolId && row.bytes_fingerprint === fingerprint && row.reach === identity)) return { approved: true };
  return { approved: false, asks: asking.map(row => row.said), approval: { tool_id: toolId, bytes_fingerprint: fingerprint, reach: identity }, file };
}

/** The command to start: argv under the profile, with its temporary files and home inside its own folder, and the
 *  values its declared reach names (`env` rows, filled from `values`, such as the socket of its proxy). */
export function sandboxed(argv, { folder, profile, reach = [], values = {}, parentEnv = process.env, rules = settings }) {
  const env = reach.flatMap(row => Object.entries(row.env ?? {}).map(([name, template]) => `${name}=${String(template).replace(/\{(\w+)\}/g, (_, key) => {
    if (typeof values[key] !== 'string' || !values[key]) throw new Error(`This computer has no ${key} to give a tool that declared ${row.kind}.`);
    return values[key];
  })}`));
  // The run sees the names the DATA allows and the names its tool declared, nothing else of this program's environment.
  const inherit = rules.environment.mode === 'inherit';
  const kept = inherit ? [] : [...new Set([...rules.environment.allow, ...reach.filter(row => row.pass_env).map(row => row.pass_env)])]
    .filter(name => typeof parentEnv[name] === 'string').map(name => `${name}=${parentEnv[name]}`);
  return ['/usr/bin/sandbox-exec', '-p', profile, '/usr/bin/env', ...(inherit ? [] : ['-i']), ...kept, `TMPDIR=${folder}/`, `HOME=${folder}`, ...env, ...argv];
}

/** A local socket in the run's folder that forwards each request to `origin` with `key` attached, so the tool acts in the
 *  person's Trillion without holding the key. Resolves to { socket, close }. */
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'proxy-authorization', 'te', 'trailer']);
export function trillionProxy({ folder, origin, key, fetchImpl = fetch }) {
  if (typeof origin !== 'string' || !origin || typeof key !== 'string' || !key) return Promise.reject(new Error('This computer has no Trillion connection to give a tool that declared trillion.'));
  // macOS holds at most 103 bytes of a socket path; the run's own folder keeps it private to this person.
  const socket = join(folder, 's');
  if (Buffer.byteLength(socket) > 103) return Promise.reject(new Error(`The run's folder ${folder} is too deep for a local socket.`));
  const base = origin.replace(/\/$/, '');
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      // The tool's own headers pass (an MCP session id, what it accepts), except those that name the connection or
      // a key: the only key is this computer's, attached here.
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP.has(name) && name !== 'authorization' && name !== 'cookie'));
      headers.authorization = `Bearer ${key}`;
      const answer = await fetchImpl(`${base}${request.url.startsWith('/') ? request.url : `/${request.url}`}`, { method: request.method, headers, body });
      response.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([name]) => !HOP.has(name) && name !== 'content-encoding' && name !== 'set-cookie')));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(socket, () => done({ socket, close: () => new Promise(closed => server.close(() => closed())) }));
  });
}
