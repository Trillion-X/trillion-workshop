// The container tool: reads one public page the way a crawler does (its served HTML, no script run), the robots.txt of
// its host and, up to the limit in the checks DATA, the pages it links to, and answers what auditServedHtml finds.
// Where a request may go is not decided here: the engine runs this tool as internet:true, so Node's own fetch reaches
// only the engine's public-only proxy, which judges every address, every redirect and every address a name resolves to.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditServedHtml } from './audit-served-html.mjs';

const MAX_BYTES = 2_000_000;
const WAIT_MS = 12_000;
const REDIRECT = [301, 302, 303, 307, 308];
const AGENT = 'Mozilla/5.0 (compatible; ai-readiness-check)';

/** A web address this tool may ask for: http or https, a host, no user name or password. */
function webAddress(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('url must be a web address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Only public HTTP and HTTPS addresses are supported.');
  return url;
}

/** One public address, its redirects followed (each hop checked), at most MAX_BYTES of body kept. */
export async function getPublic(input, { method = 'GET', fetchOnce = fetch } = {}) {
  let current = webAddress(input);
  for (let hops = 0; hops <= 5; hops++) {
    const response = await fetchOnce(current, { method, redirect: 'manual', signal: AbortSignal.timeout(WAIT_MS), headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': AGENT } });
    if (REDIRECT.includes(response.status) && response.headers.get('location')) {
      await response.body?.cancel();
      current = webAddress(new URL(response.headers.get('location'), current).href);
      continue;
    }
    if (method === 'HEAD') { await response.body?.cancel(); return { status: response.status, final_url: current.href, text: '' }; }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('The page is larger than the 2 MB limit.');
      chunks.push(chunk);
    }
    return { status: response.status, final_url: current.href, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('The page redirected too many times.');
}

/** The status of a linked address: HEAD first, and a plain GET where the server refuses HEAD. */
export async function linkStatus(url, getter = getPublic) {
  const head = await getter(url, { method: 'HEAD' }).catch(() => null);
  if (head && head.status !== 405 && head.status !== 501) return head.status;
  return (await getter(url).catch(() => null))?.status ?? 0;
}

/** Reads and audits one page. `checks` replaces the shipped check rows; `skip` names check ids not to run. */
export async function checkAPage({ url, checks, skip }, getter = getPublic) {
  const page = await getter(url);
  if (page.status < 200 || page.status >= 300) throw new Error(`The page returned HTTP ${page.status}.`);
  const robots = await getter(new URL('/robots.txt', page.final_url).href).then(answer => (answer.status >= 200 && answer.status < 300 ? answer.text : '')).catch(() => null);
  const audit = await auditServedHtml({ html: page.text, robotsTxt: robots, resolveLink: link => linkStatus(link, getter), pageUrl: page.final_url, ...(checks ? { checks } : {}), ...(skip ? { skip } : {}) });
  return {
    url, final_url: page.final_url, status: page.status, indexable: audit.indexable, score: audit.score, passed: audit.passed, failed: audit.failed,
    missing: audit.missing.map(({ id, says, fix, examples }) => ({ id, says, fix, examples: examples ?? [] })),
    suggestions: audit.suggestions.map(({ id, says, fix }) => ({ id, says, fix })),
    not_checked: audit.not_checked,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await checkAPage(input)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 2;
  }
}
