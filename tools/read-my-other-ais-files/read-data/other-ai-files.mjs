// computer/other-ai-files.mjs
//
// PURPOSE
//   Lets Trillion's AIs read the instruction, command and skill files the person already keeps for their other AIs
//   (Claude Code, Codex, Cursor, Gemini CLI), in place and labelled by the app they belong to, instead of the person
//   copying them. Run by computer/mac-tools.mjs as tool:other-ai-files; the places are computer/other-ai-files.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only. Nothing is written into those folders and nothing is imported into Trillion by this tool.
//   2. This file names no AI app, folder or file: they are the DATA rows. A new app is one more row.
//   3. Every place is a path under the person's home folder named by the DATA, and a link inside a folder is never followed.
//   4. An MCP server another app lists is described, not trusted: its command or address and the names of its
//      environment variables come back, never their values, and nothing here switches a server on.
//   5. A listing carries no file contents; `read` names the entries wanted and each comes back whole up to most_chars,
//      with its source and kind as its label, so the AI knows whose file it is reading.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(readFileSync(fileURLToPath(new URL('./other-ai-files.json', import.meta.url)), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
/** A place's path under the home folder: `~/x` is `<home>/x`; a path that is not under the home folder is not read. */
const placeAt = (place, home) => { const at = join(home, String(place).replace(/^~\/?/, '')); return at.startsWith(join(home, '/')) ? at : join(home, '.unreadable'); };
const regular = path => { try { const stat = lstatSync(path); return stat.isFile() ? stat : null; } catch { return null; } };
const folderEntries = path => { try { return readdirSync(path, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink()); } catch { return []; } };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The servers one JSON file lists under `key`, or none when it is missing, unreadable or not that shape. */
function mcpServersOf(path, key) {
  if (!regular(path)) return {};
  try { const listed = JSON.parse(readFileSync(path, 'utf8'))?.[key]; return object(listed) ? Object.fromEntries(Object.entries(listed).filter(([, row]) => object(row))) : {}; } catch { return {}; }
}
/** A listed server as described to an AI: how it starts or where it is, with each environment variable's value hidden. */
const describedServer = (row, rules) => ({
  ...(typeof row.command === 'string' ? { command: row.command } : {}), ...(Array.isArray(row.args) ? { args: row.args.filter(arg => typeof arg === 'string') } : {}),
  ...(typeof row.url === 'string' ? { url: row.url } : {}),
  ...(object(row.env) ? { env: Object.fromEntries(Object.keys(row.env).map(name => [name, rules.words.hidden])) } : {}),
  ...(object(row.headers) ? { headers: Object.fromEntries(Object.keys(row.headers).map(name => [name, rules.words.hidden])) } : {}),
});

/** Every entry the rows name that exists now: { name, source, kind, path, bytes }, `name` being source/kind/entry. */
export function otherAiEntries({ rules = RULES, home = homedir(), only = {} } = {}) {
  const entries = [];
  for (const source of rules.sources) {
    if (only.source && only.source !== source.id) continue;
    for (const place of source.places) {
      if (only.kind && only.kind !== place.kind) continue;
      const base = placeAt(place.path, home);
      const add = (entry, path, stat) => entries.push({ name: `${source.id}/${place.kind}/${entry}`, source: source.id, label: source.label, kind: place.kind, path, ...(place.key ? { key: place.key } : {}), bytes: stat.size });
      if (place.shape === 'file') { const stat = regular(base); if (stat) add(place.path.split('/').pop(), base, stat); }
      else if (place.shape === 'files') {
        for (const entry of folderEntries(base).filter(item => item.isFile() && place.endings.some(ending => item.name.endsWith(ending)))) add(entry.name, join(base, entry.name), regular(join(base, entry.name)) ?? { size: 0 });
      } else if (place.shape === 'mcp_servers') {
        for (const [server, row] of Object.entries(mcpServersOf(base, place.key))) add(server, base, { size: JSON.stringify(describedServer(row, rules)).length });
      } else if (place.shape === 'skill_folders') {
        for (const entry of folderEntries(base).filter(item => item.isDirectory())) { const stat = regular(join(base, entry.name, place.file)); if (stat) add(entry.name, join(base, entry.name, place.file), stat); }
      }
    }
  }
  return entries.slice(0, rules.most_files);
}

/** The tool: { source?, kind?, read?: [entry names] } -> { entries } (no contents) and, for each name in `read`, { files }. */
export function otherAiFiles(input = {}, { rules = RULES, home = homedir() } = {}) {
  const w = rules.words;
  const known = rules.sources.map(source => source.id);
  const kinds = [...new Set(rules.sources.flatMap(source => source.places.map(place => place.kind)))];
  if (input.source && !known.includes(input.source)) return { error: fill(w.unknown_source, { source: input.source, known: known.join(', ') }) };
  if (input.kind && !kinds.includes(input.kind)) return { error: fill(w.unknown_kind, { kind: input.kind, known: kinds.join(', ') }) };
  const entries = otherAiEntries({ rules, home, only: { source: input.source, kind: input.kind } });
  const answer = { entries: entries.map(({ path, key, ...entry }) => entry) };
  if (Array.isArray(input.read) && input.read.length) {
    answer.files = input.read.map(name => {
      const entry = entries.find(item => item.name === name);
      if (!entry) return { name, error: fill(w.not_listed, { name }) };
      const text = entry.kind === 'mcp_servers' ? JSON.stringify(describedServer(mcpServersOf(entry.path, entry.key)[entry.name.split('/').slice(2).join('/')], rules), null, 2)
        : readFileSync(entry.path, 'utf8');
      return { name, source: entry.source, label: entry.label, kind: entry.kind, text: text.slice(0, rules.most_chars), ...(text.length > rules.most_chars ? { said: fill(w.cut, { chars: rules.most_chars, total: text.length }) } : {}) };
    });
  }
  return answer;
}

export const otherAiTools = { files: input => otherAiFiles(input ?? {}) };
