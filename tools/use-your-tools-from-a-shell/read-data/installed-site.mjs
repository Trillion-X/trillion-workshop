// Strict installed-site DATA lookup for callers that cannot use invocation-name fallback.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installedCli } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

function siteData(bytes) {
  // Keep the actual bytes authoritative: neither replacement decoding nor last-member wins.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  const stack = [];
  // JSON.parse establishes syntax first, so every string token and delimiter is complete.
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const word = token[0];
    if (word === '{') stack.push(new Set());
    else if (word === '[') stack.push(null);
    else if (word === '}' || word === ']') stack.pop();
    else if (stack.at(-1) && /^[ \t\r\n]*:/.test(text.slice(token.index + word.length))) {
      const key = JSON.parse(word), keys = stack.at(-1);
      if (keys.has(key)) throw new Error('Duplicate installed-site DATA member.');
      keys.add(key);
    }
  }
  return value;
}

/** Exactly one installed site with an explicit valid command matching its installation. Read-only. */
export function installedSiteCommand({ home = homedir(), rules = settings } = {}) {
  const installed = installedCli({ home, rules });
  if (!installed) throw new Error('Exactly one installed site is required.');
  const template = rules.state_folder.replaceAll('{cli}', installed);
  const folder = template === '~' ? home : template.startsWith('~/') ? join(home, template.slice(2)) : template;
  let site;
  try { site = siteData(readFileSync(join(folder, rules.site_file))); }
  catch { throw new Error('Installed site DATA must be readable JSON.'); }
  if (!site || typeof site !== 'object' || Array.isArray(site) || !Object.hasOwn(site, 'cli')
      || typeof site.cli !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(site.cli) || site.cli !== installed) {
    throw new Error('Installed site DATA must name its explicit valid CLI command.');
  }
  return site.cli;
}
