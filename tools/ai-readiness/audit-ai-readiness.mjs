#!/usr/bin/env node
// Audits public addresses for AI answer engines: node scripts/audit-ai-readiness.mjs <url> [<url>...] [--json]
// Reads each page's served HTML (no script run), its host's robots.txt and, up to the limit in the checks DATA, its links.
import { auditServedHtml } from '../parts/ai-readiness/do-work/audit-served-html.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const urls = args.filter(arg => !arg.startsWith('--'));
if (!urls.length) { console.error('Name at least one address.'); process.exit(2); }

const get = (url, init) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; trillion-ai-readiness)' }, ...init });
const resolveLink = async url => {
  const head = await get(url, { method: 'HEAD' }).catch(() => null);
  return head && head.status !== 405 ? head.status : (await get(url).catch(() => null))?.status ?? 0;
};

const reports = [];
for (const url of urls) {
  const page = await get(url);
  const html = await page.text();
  const robots = await get(new URL('/robots.txt', url)).then(response => (response.ok ? response.text() : '')).catch(() => null);
  const audit = await auditServedHtml({ html, robotsTxt: robots, resolveLink, pageUrl: page.url });
  reports.push({ url, status: page.status, indexable: audit.indexable, score: audit.score, passed: audit.passed, failed: audit.failed,
    missing: audit.missing.map(({ id, says, fix, examples }) => ({ id, says, fix, examples })), suggestions: audit.suggestions.map(({ id, says }) => ({ id, says })), not_checked: audit.not_checked });
}
if (json) console.log(JSON.stringify(reports, null, 2));
else for (const report of reports) {
  if (!report.indexable) { console.log(`${report.url}  asks not to be indexed, so it is not scored`); continue; }
  console.log(`${report.url}  score ${report.score}  (${report.passed}/${report.passed + report.failed})`);
  for (const item of report.missing) console.log(`  missing  ${item.id}: ${item.says}${item.examples?.length ? `  e.g. ${item.examples[0]}` : ''}`);
  for (const item of report.suggestions) console.log(`  suggest  ${item.id}`);
  if (report.not_checked.length) console.log(`  not checked  ${report.not_checked.join(', ')}`);
}
