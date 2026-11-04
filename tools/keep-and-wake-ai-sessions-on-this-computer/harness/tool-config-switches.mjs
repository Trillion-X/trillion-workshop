// Retain the person's model provider while turning off their tool servers and plugins for one run.
// Empty TOML tables merge with existing tables; each configured entry must be disabled explicitly.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function toolConfigSwitches({ keep = [], config = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), read = readFileSync } = {}) {
  let text = '';
  try { text = read(config, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const kept = new Set(keep);
  const keys = new Set();
  for (const line of text.split('\n')) {
    const table = line.match(/^\s*\[(mcp_servers|plugins)\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\]\s*(?:#.*)?$/);
    if (table && !kept.has(table[2].replace(/^"|"$/g, ''))) keys.add(`${table[1]}.${table[2]}`);
    if (/^\s*(mcp_servers|plugins)\s*=/.test(line)) throw new Error('Inline tool configuration cannot be isolated safely.');
  }
  return ['-c', 'features.apps=false', ...[...keys].flatMap(key => ['-c', `${key}.enabled=false`])];
}
