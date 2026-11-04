// tools/register-trillion-in-my-ai-apps/do-work/register-in-ai-apps.mjs
//
// The person's own explicit action that puts Trillion's MCP entry into the AI apps they name, or takes it out:
//   node do-work/register-in-ai-apps.mjs --action mcp-inspect|mcp-preview|mcp-register|mcp-unregister --client <ids>
//     [--mcp-url <https, or loopback HTTP for HTTP clients>] [--reviewed <review_hash>]
// Moved from the MCP branch of Trillion-X/trillion harness/setup.mjs (its parseArgs and entry); the hook-setup
// actions of that file stay there. The answer is printed as JSON; exit 2 when it was refused or an app is blocked or
// custom, 1 on a bad request.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { json } from './config-file.mjs';
import { MCP_ACTIONS, registerMcp } from './mcp-registration.mjs';

export const settings = JSON.parse(readFileSync(new URL('../read-data/mcp-registration.json', import.meta.url), 'utf8'));

function parseArgs(argv) {
  const out = {};
  const flags = { '--action': 'action', '--client': 'clients', '--mcp-url': 'url', '--reviewed': 'reviewed' };
  for (let i = 0; i < argv.length; i += 1) {
    const field = flags[argv[i]];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --action mcp-inspect|mcp-preview|mcp-register|mcp-unregister --client <ids> [--mcp-url <https or loopback HTTP for HTTP clients; Claude Code and Codex use the installed local bridge>] [--reviewed <review_hash>].');
    out[field] = argv[++i];
  }
  return out;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!MCP_ACTIONS.includes(options.action)) throw new Error(`Use --action ${MCP_ACTIONS.join(', ')}.`);
    const { action, clients, url, reviewed } = options;
    const answer = registerMcp({ action, clients, url, reviewed, rules: settings });
    process.stdout.write(json(answer)); process.exitCode = answer.refused || answer.results.some(row => ['blocked', 'custom'].includes(row.result ?? row.now)) ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${json({ schema: 'trillion.harness-setup-error/v1', error: error.message })}`); process.exitCode = 1;
  }
}
