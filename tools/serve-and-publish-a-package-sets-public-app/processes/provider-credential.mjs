import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function providerCredentialState(configPath = join(homedir(), '.fly', 'config.yml')) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(`No host provider credential found at ${configPath}. Sign in to the provider first.`);
  }
  const accessTokenLine = text.split('\n').find((row) => row.startsWith('access_token:'));
  const accessToken = accessTokenLine ? accessTokenLine.slice('access_token:'.length).trim() : '';
  if (!accessToken) throw new Error(`No access_token in ${configPath}.`);
  const lastLoginLine = text.split('\n').find((row) => row.startsWith('last_login:'));
  const lastLogin = lastLoginLine ? lastLoginLine.slice('last_login:'.length).trim() : '';
  if (!lastLogin || Number.isNaN(Date.parse(lastLogin))) {
    throw new Error(`No valid last_login in ${configPath}.`);
  }
  return { accessToken, lastLogin };
}

/** Read the hosting provider credential without putting it in arguments, output,
 * or a durable deployment record. This module is intentionally library-only:
 * process entrypoints import it, but bundling it can never start another action. */
export function providerCredential(configPath = join(homedir(), '.fly', 'config.yml')) {
  return providerCredentialState(configPath).accessToken;
}

/** Project only the provider fields its CLI needs into the contained deployment
 * workspace. The rest of the person's provider config remains outside it. */
export function providerCredentialConfiguration(configPath = join(homedir(), '.fly', 'config.yml')) {
  const { accessToken, lastLogin } = providerCredentialState(configPath);
  return `access_token: ${accessToken}\nlast_login: ${lastLogin}\n`;
}

/** Read the Vercel provider credential without exposing it to an argument,
 * child environment, deployment result, or durable handoff file. */
export function vercelProviderCredential(
  configPath = join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`No Vercel provider credential found at ${configPath}. Sign in to the provider first.`);
  }
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) throw new Error(`No token in ${configPath}.`);
  return token;
}
