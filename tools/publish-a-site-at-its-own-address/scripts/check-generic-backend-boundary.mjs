import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const mode = process.argv.slice(2).find((arg) => arg.startsWith('--')) ?? '--all';

const sourceRoots = ['src', 'scripts'];
const packageSpecificFamilies = /\b(public-site-renderer|public-site-carrier|public-site-http|public-site-credentials|public-site-workflow|public-site-process|website-deployer|vercel-publisher|PublicationAttemptLog|PublicWebsiteProjection)\b/;
const directOwnerImport = /from\s+['"][^'"]*(hosted-public-app|public-document-renderer|public-document-site|http-client|credentials-vault|service-connections|workflow|process-session)[^'"]*['"]/;
const closedBranch = /\b(status|provider|deployment|lead|campaign|calendar|mail)\b\s*(===|!==|==|!=)\s*['"]/;

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return files(path);
    return /\.(mjs|js|ts|tsx|json)$/.test(name) ? [path] : [];
  });
}

function scan() {
  const offenders = [];
  for (const file of sourceRoots.flatMap((dir) => files(join(root, dir)))) {
    if (file.endsWith('check-generic-backend-boundary.mjs')) continue;
    if (file.endsWith('.test.mjs')) continue;
    const text = readFileSync(file, 'utf8');
    if (packageSpecificFamilies.test(text)) offenders.push(`${relative(root, file)}: package-specific backend family`);
    if (directOwnerImport.test(text)) offenders.push(`${relative(root, file)}: direct owner import`);
    if (closedBranch.test(text)) offenders.push(`${relative(root, file)}: closed Society branch`);
  }
  return offenders;
}

const offenders = scan();
assert.deepEqual(offenders, []);

if (mode === '--imports') console.log('[public-site-publisher] no direct owner imports ok');
else console.log('[public-site-publisher] l093 boundary ok');
