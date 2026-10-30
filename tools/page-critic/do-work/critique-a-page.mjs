// tools/page-critic/do-work/critique-a-page.mjs
//
// Purpose
//   Judges one public page the way a careful designer would, at every width the craft rules name, and keeps a marked
//   picture of each width: every finding is boxed on the page before the picture is taken, so whoever fixes it sees
//   exactly where. It is the Workshop tool tool:critique-a-public-page (a deployed container with a browser and the
//   internet).
//
//   node do-work/critique-a-page.mjs [--url <page>] [--pages-from <sitemap url> [--skip /prefix,/prefix]] --out <folder>
//   [--fresh-within-days N | '{"/path": N}'] [--rules <file>] [--browser chromium, or BROWSER_EXECUTABLE]
//   prints one JSON line: { said, pages, findings_count, findings: [{ url, rule, width, says, text?, selector?, rect?, picture }],
//   pictures: [{ url, width, picture, findings }] }
//
// Non-negotiable invariants
//   1. What counts as broken, and every threshold and selector, is DATA (read-data/page-craft-rules.json); each
//      measurement is one entry of MEASURES, picked by its rule's id, and a rule a page's DATA leaves out is not run.
//   2. A finding names the rule, the width, the words a person reads (the rule's `says` filled in) and where it is.
//   3. The page is only read: nothing is clicked, typed or sent (it is scrolled once to wake lazy pictures); each link is asked once with GET and only its status read. An embedded frame is read through an isolated DevTools world, never changed.
//   4. However the run ends, the browser ends with it (tools/headless-browser/devtools.mjs).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../headless-browser/devtools.mjs';
import { bindControlNameEvidence, pageCraftMeasures, pageCraftHelpers as HELPERS } from './measure-page-craft.mjs';
import { collectControlNames } from './collect-control-names.mjs';
import { demoFramesForRule } from './frame-selection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, word, index, all) => (word.startsWith('--') ? [...pairs, [word.slice(2), all[index + 1]]] : pairs), []));
const craft = JSON.parse(readFileSync(args.rules ?? join(here, '../read-data/page-craft-rules.json'), 'utf8'));
const out = args.out ?? join(here, '../out');
mkdirSync(join(out, 'pictures'), { recursive: true });
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const IN_PAGE = pageCraftMeasures;

const evaluate = async (page, expression, contextId) => {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

// Lazy pictures and frames load only when scrolled near, so the page is read top to bottom once (nothing is clicked) and back.
async function scrollThrough(page) {
  const { step_ms, most_steps } = craft.scroll;
  await evaluate(page, `(async () => { const step = window.innerHeight * 0.8; for (let at = 0, n = 0; at < document.documentElement.scrollHeight && n < ${most_steps}; at += step, n++) { window.scrollTo(0, at); await new Promise(done => setTimeout(done, ${step_ms})); } window.scrollTo(0, 0); await new Promise(done => setTimeout(done, ${step_ms})); })()`);
}

// What each frame's own document answered (status, or why it failed), heard from DevTools while the page loads.
function trackFrames(page) {
  if (page.frameAnswers) return page.frameAnswers;
  const answers = { requests: new Map(), documents: new Map() };
  page.on(({ method, params }) => {
    if (method === 'Network.requestWillBeSent' && params.type === 'Document' && params.frameId) answers.requests.set(params.requestId, params.frameId);
    if (method === 'Network.responseReceived' && params.type === 'Document') answers.documents.set(params.frameId, { status: params.response.status });
    if (method === 'Network.loadingFailed' && answers.requests.has(params.requestId)) answers.documents.set(answers.requests.get(params.requestId), { failed: params.errorText || params.blockedReason || 'blocked' });
  });
  page.frameAnswers = answers;
  return answers;
}

// Every frame inside the page (to craft.most_frame_depth), with its owner element: where it is, its src and a selector.
async function framesOf(page) {
  await page.send('DOM.enable');
  const { frameTree } = await page.send('Page.getFrameTree');
  const found = [];
  const queue = [{ node: frameTree, depth: 1, origin: { x: 0, y: 0 } }];
  while (queue.length) {
    const { node, depth, origin } = queue.shift();
    for (const child of node.childFrames ?? []) {
      let owner = null;
      try {
        const { backendNodeId } = await page.send('DOM.getFrameOwner', { frameId: child.frame.id });
        const { object } = await page.send('DOM.resolveNode', { backendNodeId });
        const { result } = await page.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function () { ${HELPERS} const element = this; return { src: element.getAttribute('src') || '', selector: pathOf(element), shown: shown(element), rect: where(element) }; }` });
        owner = result.value;
      } catch { /* a frame whose owner cannot be reached is skipped */ }
      if (!owner) { found.push({ frame: child.frame, owner: null, depth }); continue; }
      const rect = { ...owner.rect, x: owner.rect.x + origin.x, y: owner.rect.y + origin.y };
      found.push({ frame: child.frame, owner: { ...owner, rect }, depth });
      if (depth < craft.most_frame_depth) queue.push({ node: child, depth: depth + 1, origin: { x: rect.x, y: rect.y } });
    }
  }
  return found;
}

const worldOf = async (page, frameId) => (await page.send('Page.createIsolatedWorld', { frameId, worldName: 'page-critic' })).executionContextId;
const matchesAny = (patterns, text) => patterns.some(source => new RegExp(source, 'i').test(text));

// The rules marked `in_frames` run again inside each visible embedded frame (same-origin or not), and the finding is
// named by the frame's own selector first, then the element's, with its box moved to where the frame sits on the page.
async function judgeFrames(page, rules, width, url) {
  const wanted = rules.filter(rule => rule.in_frames);
  if (!wanted.length) return [];
  const found = [];
  const controlRule = wanted.find(rule => rule.id === 'control_name');
  const unavailable = (frame, owner, reason) => found.push({ rule: 'control_name', values: { kind: 'unavailable', role: 'embedded-frame', text: 'embedded frame control', reason }, text: 'embedded frame control', selector: owner?.selector ?? null, rect: owner?.rect ?? null, frame: frame.url });
  for (const { frame, owner } of (await framesOf(page)).slice(0, craft.most_frames_scanned)) {
    if (owner && !owner.shown) continue;
    if (matchesAny(craft.frames_ignored, `${frame.url} ${owner?.src ?? ''}`)) continue;
    if (!owner) { if (controlRule) unavailable(frame, owner, 'the visible frame owner could not be resolved'); continue; }
    if (frame.unreachableUrl) { if (controlRule) unavailable(frame, owner, 'the visible frame could not be reached'); continue; }
    try {
      const controlNames = controlRule ? await collectControlNames({
        send: (method, params) => page.send(method, params),
        selector: craft.selectors.control_name_candidates,
        roles: controlRule.roles,
        frameId: frame.id,
      }) : [];
      let measured = await evaluate(page, `${IN_PAGE}(${JSON.stringify({ rules: wanted, selectors: craft.selectors, freshDays: null, now: Date.now(), widthId: width.id, controlNames })})`, await worldOf(page, frame.id));
      if (controlRule) {
        const after = await collectControlNames({
          send: (method, params) => page.send(method, params),
          selector: craft.selectors.control_name_candidates,
          roles: controlRule.roles,
          frameId: frame.id,
        });
        measured = bindControlNameEvidence(measured, controlNames, after);
      }
      for (const item of measured.found) {
        const inside = item.rect && item.rect.x < owner.rect.width && item.rect.y < owner.rect.height;
        found.push({ ...item, values: { ...item.values, ...(item.values.selector ? { selector: `${owner.selector} >> ${item.values.selector}` } : {}), ...(item.values.first_selector ? { first_selector: `${owner.selector} >> ${item.values.first_selector}` } : {}), frame: frame.url }, selector: `${owner.selector} >> ${item.selector ?? ''}`.replace(/ >> $/, ''), rect: inside ? { x: owner.rect.x + item.rect.x, y: owner.rect.y + item.rect.y, width: Math.min(item.rect.width, owner.rect.width - item.rect.x), height: Math.min(item.rect.height, owner.rect.height - item.rect.y) } : owner.rect });
      }
    } catch (error) {
      if (controlRule) unavailable(frame, owner, `the browser could not read this frame's accessibility tree: ${String(error?.message ?? error).slice(0, 160)}`);
      // A visible, inventoried frame that changes while AX is read is unknown and therefore refuses the requested rule.
    }
  }
  return found;
}

// An embedded live demo (a frame whose address is one of the rule's demo_url_patterns) is given `wait_seconds` to load.
// It is a finding when it fails to load, when its words say something went wrong (an alert-like element, or one of the
// plain phrases anywhere), or when it is still empty at the end.
async function watchDemos(page, rule, width) {
  const answers = trackFrames(page);
  const found = [];
  const reported = new Set();
  const report = (demo, kind, text) => {
    if (reported.has(`${demo.frame.id}:${kind}`)) return;
    reported.add(`${demo.frame.id}:${kind}`);
    found.push({ rule: rule.id, values: { kind, text: text.slice(0, 120), selector: demo.owner.selector, demo: demo.owner.src || demo.frame.url, seconds: rule.wait_seconds }, text: text.slice(0, 120), selector: demo.owner.selector, rect: demo.owner.rect });
  };
  const readerFor = `(() => { const rule = ${JSON.stringify({ errors: rule.error_phrases, alerts: rule.alert_phrases, empty: rule.empty_phrases, min: rule.alert_min_chars })}; const alerts = [...document.querySelectorAll(${JSON.stringify(craft.selectors.alerts)})]; const text = (document.body ? document.body.innerText : '').trim(); const hit = (list, from) => list.map(source => new RegExp(source, 'i').exec(from)).find(Boolean); const line = (from, match) => from.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\\s+/g, ' ').trim(); let error = hit(rule.errors, text); let source = text; if (!error) for (const element of alerts) { const inner = (element.innerText || '').trim(); const found = inner.length >= rule.min ? hit(rule.alerts, inner) : null; if (found) { error = found; source = inner; break; } } const empty = hit(rule.empty, text); return { error: error ? line(source, error) : null, empty: empty ? line(text, empty) : null, chars: text.length, media: document.querySelectorAll(${JSON.stringify(craft.selectors.demo_media)}).length }; })()`;
  const deadline = Date.now() + rule.wait_seconds * 1000;
  let sawDemo = false;
  for (let round = 0; ; round++) {
    const demos = demoFramesForRule(await framesOf(page), rule);
    if (!demos.length && !sawDemo) return found;
    sawDemo = true;
    const last = Date.now() >= deadline;
    for (const demo of demos) {
      const answer = answers.documents.get(demo.frame.id);
      if (demo.frame.unreachableUrl || /^chrome-error:/.test(demo.frame.url) || answer?.failed) { report(demo, 'failed', `did not load: ${answer?.failed ?? 'the address could not be reached'}`); continue; }
      if (answer?.status >= 400) { report(demo, 'failed', `did not load: answered ${answer.status}`); continue; }
      let read;
      try { read = await evaluate(page, readerFor, await worldOf(page, demo.frame.id)); } catch { continue; }
      if (read.error) report(demo, 'error', read.error);
      else if (last && (read.empty || (read.chars < rule.empty_max_chars && !read.media))) report(demo, 'empty', read.empty ?? `only ${read.chars} characters of text and no picture`);
    }
    if (last || (demos.length && demos.every(demo => ['failed', 'error'].some(kind => reported.has(`${demo.frame.id}:${kind}`))))) return found;
    await wait(rule.poll_ms);
  }
}

// Which interactive elements look the same with the pointer resting on them (CSS :hover forced through DevTools).
async function withoutHover(page, rule) {
  await page.send('DOM.enable');
  await page.send('CSS.enable');
  const { root } = await page.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await page.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: craft.selectors.hoverable });
  const found = [];
  for (const nodeId of nodeIds.slice(0, craft.most_hovers_checked)) {
    const read = async () => {
      const { object } = await page.send('DOM.resolveNode', { nodeId });
      const { result } = await page.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function (names) { const box = this.getBoundingClientRect(); if (!box.width || !box.height) return null; const style = getComputedStyle(this); return { text: (this.innerText || this.getAttribute('aria-label') || this.getAttribute('title') || this.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 60), rect: { x: Math.round(box.left), y: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height) }, look: names.map(name => style.getPropertyValue(name)).join('|') }; }`, arguments: [{ value: rule.styles }] });
      return result.value;
    };
    const resting = await read();
    if (!resting) continue;
    await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    const hovered = await read();
    await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    if (hovered && hovered.look === resting.look) found.push({ rule: rule.id, values: { text: resting.text }, text: resting.text, rect: resting.rect });
  }
  return found;
}

// A link is asked with GET as a browser opens it (HEAD is answered differently by many servers: app.gettrillion.ai/docs
// answers HEAD 404 and GET 200), and only its status is read.
async function linkStatus(url) {
  try {
    const answer = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    await answer.body?.cancel();
    return answer.status;
  } catch (error) { return String(error?.cause?.code ?? error?.name ?? 'no answer'); }
}

const rulesAt = width => craft.rules.filter(rule => !rule.widths || rule.widths.includes(width.id));

// The pages to judge: the one given, and every page a sitemap lists (--pages-from), less the paths --skip names.
async function pagesToJudge() {
  const pages = args.url ? [args.url] : [];
  if (args['pages-from']) {
    const listed = await (await fetch(args['pages-from'], { signal: AbortSignal.timeout(20000) })).text();
    const skip = (args.skip ?? '').split(',').map(item => item.trim()).filter(Boolean);
    for (const [, url] of listed.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) if (!skip.some(prefix => new URL(url).pathname.startsWith(prefix))) pages.push(url);
  }
  return [...new Set(pages)].slice(0, craft.most_pages);
}
// How old the newest date may be on each page: one number for every page, or { path: days } for some.
const freshness = (() => { const given = args['fresh-within-days']; if (!given) return () => null; try { const read = JSON.parse(given); return url => (typeof read === 'number' ? read || null : read[new URL(url).pathname] ?? null); } catch { return () => null; } })();

async function judge(page, url, width, checkedLinks) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: width.width, height: width.height, deviceScaleFactor: 1, mobile: width.width < 600 });
  const answers = trackFrames(page);
  answers.requests.clear();
  answers.documents.clear();
  await page.send('Page.navigate', { url });
  await wait(craft.settle_ms);
  await evaluate(page, 'document.readyState === "complete" || new Promise(done => addEventListener("load", done, { once: true }))');
  await wait(craft.settle_ms);
  await scrollThrough(page);
  const rules = rulesAt(width);
  const controlRule = rules.find(rule => rule.id === 'control_name');
  const controlNames = controlRule ? await collectControlNames({
    send: (method, params) => page.send(method, params),
    selector: craft.selectors.control_name_candidates,
    roles: controlRule.roles,
  }) : [];
  const demo = rules.find(rule => rule.id === 'stale_demo');
  const demos = demo ? await watchDemos(page, demo, width) : [];
  let measured = await evaluate(page, `${IN_PAGE}(${JSON.stringify({ rules, selectors: craft.selectors, freshDays: freshness(url), now: Date.now(), widthId: width.id, controlNames })})`);
  if (controlRule) {
    const after = await collectControlNames({
      send: (method, params) => page.send(method, params),
      selector: craft.selectors.control_name_candidates,
      roles: controlRule.roles,
    });
    measured = bindControlNameEvidence(measured, controlNames, after);
  }
  const found = [...measured.found, ...demos, ...await judgeFrames(page, rules, width, url)];
  const hover = rules.find(rule => rule.id === 'no_hover');
  if (hover) found.push(...await withoutHover(page, hover));
  const broken = rules.find(rule => rule.id === 'broken_link');
  if (broken) {
    for (const link of measured.links.slice(0, craft.most_links_checked)) {
      if (!checkedLinks.has(link.href)) checkedLinks.set(link.href, await linkStatus(link.href));
      const status = checkedLinks.get(link.href);
      if (typeof status !== 'number' || status >= 400) found.push({ rule: broken.id, values: { text: link.text, url: link.href, status }, text: link.text, rect: null });
    }
  }
  // Each rule keeps its first findings, so one repeated mistake never hides the rest.
  const kept = [];
  for (const rule of rules) {
    const said = new Set();
    kept.push(...found.filter(item => item.rule === rule.id).filter(item => { const key = JSON.stringify(item.values); return !said.has(key) && said.add(key); }).slice(0, rule.most_findings ?? craft.most_findings_per_rule).map(item => ({ url, rule: item.rule, width: width.id, says: fill(rule.says_by_kind?.[item.values.kind] ?? rule.says, item.values), ...(item.text ? { text: item.text } : {}), ...(item.selector ? { selector: item.selector } : {}), ...(item.rect ? { rect: item.rect } : {}) })));
  }
  // Every finding boxed and numbered on the page, then the whole page photographed.
  await evaluate(page, `(${String((boxes) => { boxes.forEach((box, index) => { const mark = document.createElement('div'); Object.assign(mark.style, { position: 'absolute', left: `${box.x - 3}px`, top: `${box.y - 3}px`, width: `${box.width + 6}px`, height: `${box.height + 6}px`, outline: '3px solid #ff1d1d', zIndex: 2147483647, pointerEvents: 'none' }); const label = document.createElement('div'); label.textContent = String(index + 1); Object.assign(label.style, { position: 'absolute', left: '-3px', top: '-22px', background: '#ff1d1d', color: '#fff', font: '600 13px/18px sans-serif', padding: '0 6px', borderRadius: '4px' }); mark.append(label); document.body.append(mark); }); })})(${JSON.stringify(kept.filter(item => item.rect).map(item => item.rect))})`);
  const height = Math.min(measured.height, craft.longest_picture_px);
  await page.send('Emulation.setDeviceMetricsOverride', { width: width.width, height, deviceScaleFactor: 1, mobile: width.width < 600 });
  await wait(400);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: width.width, height, scale: 1 }, captureBeyondViewport: true });
  const picture = `pictures/${`${new URL(url).hostname}${new URL(url).pathname}`.replace(/[^a-z0-9.]+/gi, '-').replace(/-+$/, '')}-${width.id}.png`;
  writeFileSync(join(out, picture), Buffer.from(data, 'base64'));
  return { picture, kept };
}

const pages = await pagesToJudge();
const report = { pages: pages.length, findings_count: 0, findings: [], pictures: [] };
const checkedLinks = new Map();
for (const width of craft.widths) {
  const page = await openBrowser(args.browser || process.env.BROWSER_EXECUTABLE || 'chromium', width);
  try {
    await page.send('Page.enable');
    await page.send('Network.enable');
    for (const url of pages) {
      try {
        const { picture, kept } = await judge(page, url, width, checkedLinks);
        report.pictures.push({ url, width: width.id, picture, findings: kept.length });
        report.findings.push(...kept.map(item => ({ ...item, picture })));
      } catch (error) {
        report.findings.push({ url, rule: 'could_not_open', width: width.id, says: fill(craft.could_not_open, { error: String(error?.message ?? error).slice(0, 200) }) });
      }
    }
  } finally {
    page.close();
  }
}
report.findings_count = report.findings.length;
// One line a person reads first: how many findings on how many pages, the worst page named.
const byPage = Object.entries(report.findings.reduce((counts, item) => ({ ...counts, [item.url]: (counts[item.url] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
report.said = fill(report.findings_count ? craft.said_findings : craft.said_none, { findings: report.findings_count, pages: pages.length, worst: byPage[0]?.[0] ?? '' });
process.stdout.write(`${JSON.stringify(report)}\n`);
