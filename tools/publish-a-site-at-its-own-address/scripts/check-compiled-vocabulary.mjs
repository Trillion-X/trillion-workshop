import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const checkedRoots = ['src'];
const optionalBuiltRoots = ['dist', '.bitfield-entry-scope'];
const bannedInGenericCode = /\b(redeploy|deployment hash|artifact hash|process descriptor|package descriptor|CAS|eeaf|fact|provider_api_key|vercel|netlify|cloudflare)\b/i;

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return files(path);
    return /\.(mjs|js|ts|tsx|json)$/.test(name) ? [path] : [];
  });
}

const scanned = [
  ...checkedRoots.flatMap((dir) => files(join(root, dir))),
  ...optionalBuiltRoots.flatMap((dir) => files(join(root, dir))),
].filter((file) => !file.endsWith('.test.mjs'));

const offenders = scanned.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return bannedInGenericCode.test(text) ? [`${relative(root, file)}: banned backend/provider vocabulary`] : [];
});

assert.deepEqual(offenders, []);
console.log('[public-site-publisher] vocabulary boundary ok');
