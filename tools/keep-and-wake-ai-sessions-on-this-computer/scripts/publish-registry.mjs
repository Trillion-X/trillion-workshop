// List Trillion in the official MCP Registry from server.json.
//   node scripts/publish-registry.mjs
// Signs in to the registry with the GitHub account the `gh` command is signed in to. The GitHub token is read
// from `gh` into memory and exchanged for a short registry token; it is never printed, written, or passed as an argument.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.modelcontextprotocol.io';
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

const githubToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const auth = await fetch(`${REGISTRY}/v0/auth/github-at`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github_token: githubToken }) });
const authBody = await auth.json();
if (!auth.ok) throw new Error(`registry sign-in failed (${auth.status}): ${JSON.stringify(authBody).slice(0, 300)}`);

const published = await fetch(`${REGISTRY}/v0/publish`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authBody.registry_token}` }, body: JSON.stringify(server) });
const publishedBody = await published.text();
process.stdout.write(`${published.status} ${publishedBody.slice(0, 600)}\n`);
if (!published.ok) process.exitCode = 1;
