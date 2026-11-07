// parts/screen-matrix/check-screens.mjs
//
// PURPOSE
//   One headless check every deploy runs before it goes live: every screen, in every width and every way a person may
//   have their device set (light, dark, forced colours, Dark Reader), is opened and every piece of text a person can
//   see on it is read. It refuses a screen whose text cannot be read (contrast against the colour really behind it),
//   is drawn by a platform font instead of the font the page asked for, is cut off or leaves the window, or makes a
//   phone scroll sideways. Both Trillion deploys (this repository's and trillion-site's) import this file, so one
//   engine decides for both.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Screens, widths, modes and thresholds are DATA (views.json, a screens file); nothing here names a page, a width
//      or a mode, and every mode row is applied by the same code (media emulation, an init script, an extension).
//   2. Every probe is generic over the visible text on the page (in-page.mjs); a probe never knows which page it reads.
//   3. Text a person cannot see (hidden, aria-hidden, zero-size, transparent, clipped away) is never judged.
//   4. A screen that does not open is a failure, never a skip.
//   5. Offline: this opens the origin it is given and nothing else.
//
// SHAPE
//   runMatrix({ target, screens, views, allowlist, only, outDir, say }) -> { failures, report }
//     target: { origin, newContext(options) } (a Playwright browser's newContext, or openWorkerInBrowser's);
//     a failure is { screen, width, mode, probe, selector, text, detail }, probe one of contrast, font, overflow,
//     horizontal-scroll, open.
//   node check-screens.mjs --origin URL --screens FILE [--only screen,...] [--widths id,...] [--modes id,...]
//     [--extension DIR] [--out DIR] [--report FILE] [--pool N]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, launchPersistentChromium } from '../headless-browser/launch.mjs';
import { readPageFacts, readWindow, samplePixels } from './in-page.mjs';
import { bindControlNameEvidence, pageCraftMeasures } from '../page-critic/do-work/measure-page-craft.mjs';
import { collectControlNames } from '../page-critic/do-work/collect-control-names.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const readViews = () => JSON.parse(readFileSync(join(here, 'views.json'), 'utf8'));
export const readAllowlist = () => JSON.parse(readFileSync(join(here, 'allowlist.json'), 'utf8')).rows;
const darkReaderSource = () => readFileSync(join(here, 'vendor/darkreader.js'), 'utf8');

const light = ([r, g, b]) => {
  const channel = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrastRatio = (a, b) => { const [x, y] = [light(a), light(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Where the seconds go: every phase of every view adds its milliseconds here (runMatrix returns the sums in report.timing).
const timed = async (clock, phase, work) => { const began = Date.now(); try { return await work(); } finally { clock[phase] = (clock[phase] ?? 0) + Date.now() - began; } };
const rgb = colour => `rgb(${colour.slice(0, 3).map(Math.round).join(',')})`;

// A mode row's emulation, applied the same way for every mode.
function contextOptions(width, mode) {
  return {
    viewport: width.viewport,
    deviceScaleFactor: 1,
    isMobile: !!width.mobile,
    hasTouch: !!width.mobile,
    colorScheme: mode.colour_scheme ?? 'light',
    forcedColors: mode.forced_colors ?? 'none',
    reducedMotion: 'reduce',
  };
}

// Requests a page has open, so a screen is read when its data has arrived and not a fixed time after: quiet is true once
// nothing is in flight (a page's event stream, which never ends, does not count) and nothing started or ended for still_ms.
function watchRequests(page) {
  const open = new Map();
  let changed = Date.now();
  page.on('request', request => { if (!['eventsource', 'websocket'].includes(request.resourceType())) { open.set(request, Date.now()); changed = Date.now(); } });
  const done = request => { if (open.delete(request)) changed = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    async quiet(within, stillMs) {
      for (const until = Date.now() + within; ; await new Promise(resolve => setTimeout(resolve, 30))) {
        if (!open.size && Date.now() - changed >= stillMs) return true;
        if (Date.now() >= until) return false;
      }
    },
  };
}

// Two frames and a beat: what a change of scheme, scroll or style does to the page has been drawn.
// Entrances and colour transitions that end are waited out (the ones that never end, a spinner, are not): text read in the middle of a fade has the wrong colour.
const drawn = (page, beatMs, capMs) => page.evaluate(async ([beat, cap]) => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, beat))));
  const ending = document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
  if (ending.length) await Promise.race([Promise.allSettled(ending.map(animation => animation.finished)), new Promise(resolve => setTimeout(resolve, cap))]);
}, [beatMs, capMs]);

// Dark Reader switched on in a page that is already open, the way a person turns the extension on in a tab.
async function startDarkReader(page, source, options) {
  await page.evaluate(source);
  await page.evaluate(settings => { window.DarkReader.setFetchMethod(window.fetch); window.DarkReader.enable(settings); }, options);
}

async function openScreen({ page, watch, mode, screen, origin, views, say }) {
  const within = views.open_within_ms;
  await page.goto(`${origin}${screen.route}`, { waitUntil: 'domcontentloaded', timeout: within });
  if (screen.ready?.selector) await page.waitForSelector(screen.ready.selector, { state: screen.ready.state ?? 'visible', timeout: within });
  if (screen.ready?.gone) await page.waitForSelector(screen.ready.gone, { state: 'detached', timeout: within });
  if (!await watch.quiet(views.idle_within_ms, views.quiet_ms)) say(`  ${screen.id}: requests never went quiet`);
  await page.evaluate(() => document.fonts.ready);
  if (mode.darkreader && mode.apply !== 'live') await page.waitForFunction(() => document.querySelector('style.darkreader, style[data-darkreader-mode]') !== null, null, { timeout: 8000 });
  if (mode.extension) await page.waitForFunction(() => document.documentElement.hasAttribute('data-darkreader-scheme'), null, { timeout: 8000 });
  for (const step of screen.steps ?? []) {
    if (step.do === 'click') await page.locator(step.selector).first().click({ timeout: within });
    else if (step.do === 'wait') await page.waitForTimeout(step.ms);
    else throw new Error(`no step named ${step.do}`);
  }
  await drawn(page, screen.settle_ms ?? views.settle_ms, views.animation_wait_ms);
}

// The scroller that holds most of the page: the document, or the biggest element inside it that scrolls.
const scrollOn = async ({ step, beat }) => {
  const state = (window.__screenMatrix ??= {});
  // Text the last window found half inside a scroller is brought to the middle of it first.
  if (state.want?.isConnected) {
    const want = state.want;
    state.want = null;
    want.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, beat))));
    return true;
  }
  if (!state.scroller) {
    const root = document.scrollingElement ?? document.documentElement;
    let best = root.scrollHeight > innerHeight + 2 ? root : null;
    if (!best) {
      let area = 0;
      for (const element of document.body.querySelectorAll('*')) {
        const own = getComputedStyle(element);
        if (!/(auto|scroll)/.test(own.overflowY) || element.scrollHeight <= element.clientHeight + 2) continue;
        const rect = element.getBoundingClientRect();
        const size = rect.width * Math.min(rect.height, innerHeight);
        if (size > area) { area = size; best = element; }
      }
    }
    state.scroller = best ?? root;
  }
  const at = state.scroller.scrollTop;
  state.scroller.scrollTop = at + step;
  const moved = state.scroller.scrollTop > at;
  if (moved) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, beat))));
  return moved;
};

// Back to the top of everything that was scrolled, so the next mode reads the page from its first window as the first did.
const scrollToTop = () => {
  const state = (window.__screenMatrix ??= {});
  state.scroller = null;
  for (const element of [document.scrollingElement, ...document.body.querySelectorAll('*')]) if (element && element.scrollTop) element.scrollTop = 0;
};

async function pixelsOf({ page, decoder, boxes, ring, clock }) {
  if (!boxes.length) return [];
  const png = (await timed(clock, 'pixels.shot', () => page.screenshot({ animations: 'disabled', caret: 'hide' }))).toString('base64');
  return timed(clock, 'pixels.decode', () => decoder.evaluate(samplePixels, { png, boxes, pad: ring }));
}

// The fonts a platform drew text with are asked of DevTools once for each distinct font key (the font properties and the
// characters of an element's own text; in-page.mjs) and kept for the rest of the page's load, so a page of a thousand
// texts asks for a few dozen answers, and the other modes of the same load ask for none.
async function platformFonts({ page, held, cache, items }) {
  const asked = new Map();
  for (const item of items) if (item.fontKey && !cache.has(item.fontKey) && !asked.has(item.fontKey)) asked.set(item.fontKey, item.mark);
  if (!asked.size) return;
  if (!held.session) {
    held.session = await page.context().newCDPSession(page);
    await held.session.send('DOM.enable');
  }
  // The control-name read may have opened the session first, with DOM only: without CSS.enable every
  // CSS.getPlatformFontsForNode below throws, and a font that never loaded would read as no font at all.
  if (!held.css) {
    await held.session.send('CSS.enable');
    await held.session.send('DOM.getDocument', { depth: 0 });
    held.css = true;
  }
  const { session } = held;
  await Promise.all([...asked].map(async ([key, mark]) => {
    let fonts = [];
    try {
      const { result } = await session.send('Runtime.evaluate', { expression: `window.__screenMatrix?.byMark.get(${mark})?.deref() ?? null` });
      if (result.objectId) {
        const { nodeId } = await session.send('DOM.requestNode', { objectId: result.objectId });
        fonts = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
        await session.send('Runtime.releaseObject', { objectId: result.objectId });
      }
    } catch { fonts = []; }
    cache.set(key, fonts);
  }));
}

/** The decided colour (views.json decided_colours) the text or its ground is, if any: its words are judged at that row's bar. */
const decidedOf = (views, colours) => (views.decided_colours ?? []).find(row => colours.some(colour => colour
  && Math.hypot(colour[0] - row.colour[0], colour[1] - row.colour[1], colour[2] - row.colour[2]) <= row.near));

async function readScreen({ page, decoder, width, mode, screen, views, fontsAllowed, clock, held, fontCache }) {
  const t = views.thresholds;
  const failures = [];
  // A control-name finding carries two paths: the structural one it is bound by, and displaySelector, the short human
  // path (with the control's class) that every other probe here reports. The report names it by the human one, unless
  // that path names more than one shown control on the page (displayShared): then by the structural one, which is unique.
  const add = (probe, item, detail) => failures.push({ probe, selector: (item?.displayShared ? item?.selector : item?.displaySelector ?? item?.selector) ?? null, text: item?.text ?? null, detail, mark: item?.mark ?? null });
  // Contrast on a decided colour: its own bar for its words, and what still fails is reported, never refused.
  const judge = (item, ratio, need, colours, detail) => {
    const decided = decidedOf(views, colours);
    const bar = decided && (item.fontWeight ?? 400) >= decided.words_weight_at_least ? Math.min(need, decided.bar) : need;
    if (ratio >= bar) return;
    if (decided) add('decided-colour', item, `${detail(bar)}; a decided look value, reported: ${decided.why}`);
    else add('contrast', item, detail(bar));
  };
  if (views.craft_rules?.length) {
    const craft = JSON.parse(readFileSync(join(here, '../page-critic/read-data/page-craft-rules.json'), 'utf8'));
    const rules = views.craft_rules.map(id => {
      const rule = craft.rules.find(row => row.id === id);
      if (!rule) throw new Error(`Unknown shared page-craft rule: ${id}`);
      return rule;
    });
    const controlRule = rules.find(rule => rule.id === 'control_name');
    const controlNames = controlRule ? await timed(clock, 'read.craft.ax', async () => {
      if (!held.session) {
        held.session = await page.context().newCDPSession(page);
        await held.session.send('DOM.enable');
      }
      return collectControlNames({
        send: (method, params) => held.session.send(method, params),
        selector: craft.selectors.control_name_candidates,
        roles: controlRule.roles,
      });
    }) : [];
    let measured = await timed(clock, 'read.craft', () => page.evaluate(`${pageCraftMeasures}(${JSON.stringify({ rules, selectors: craft.selectors, freshDays: null, now: Date.now(), widthId: width.id, controlNames })})`));
    if (controlRule) {
      const after = await timed(clock, 'read.craft.ax.after', () => collectControlNames({
        send: (method, params) => held.session.send(method, params),
        selector: craft.selectors.control_name_candidates,
        roles: controlRule.roles,
      }));
      measured = bindControlNameEvidence(measured, controlNames, after);
    }
    if (measured.unsupported?.length) throw new Error(`Shared page-craft measurements unavailable: ${measured.unsupported.join(', ')}`);
    for (const finding of measured.found) {
      const rule = rules.find(row => row.id === finding.rule);
      const detail = (rule.says_by_kind?.[finding.values.kind] ?? rule.says).replace(/\{(\w+)\}/g, (whole, key) => finding.values[key] === undefined ? whole : String(finding.values[key]));
      add(finding.rule, finding, detail);
    }
  }
  const facts = await timed(clock, 'read.facts', () => page.evaluate(readPageFacts, { tolerance_px: t.tolerance_px, width: width.viewport.width }));
  if (width.no_horizontal_scroll) {
    const wide = facts.scrollWidth > width.viewport.width + t.tolerance_px || facts.innerWidth > width.viewport.width + t.tolerance_px;
    if (wide) {
      const where = facts.widest.map(row => `${row.selector} reaches ${row.right}px`).join('; ');
      add('horizontal-scroll', { selector: facts.widest[0]?.selector ?? 'html', text: null },
        `page is ${Math.max(facts.scrollWidth, facts.innerWidth)}px wide in a ${width.viewport.width}px window${where ? `: ${where}` : ''}`);
    }
  }
  const config = { ...t, width: width.viewport.width, pass: `${screen.id}/${width.id}/${mode.id}` };
  const seen = [];
  let texts = 0;
  // Text below the fold is read once as the page first draws it, before scrolling lights it (a reveal can leave it dimmed until it is reached).
  // It is read with motion allowed, the way most people have it, because a reduced-motion page shows such text already lit.
  const first = await timed(clock, 'read.first', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Transitions are cut so the settled state shows at once rather than after the delays a page staggers them by.
    const cut = await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    await drawn(page, 0, views.animation_wait_ms);
    const rows = (await page.evaluate(readWindow, { ...config, pass: `${config.pass}/first`, everywhere: true })).items.filter(item => !item.pixels && item.observed && item.ground && !item.disabled);
    await cut.evaluate(node => node.remove());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    return rows;
  });
  for (let step = 0; step <= views.max_scroll_steps; step += 1) {
    const read = await timed(clock, 'read.window', () => page.evaluate(readWindow, config));
    const sampled = read.items.filter(item => item.pixels);
    const rows = await pixelsOf({ page, decoder, boxes: sampled.map(item => item.box), ring: t.ring_px, clock });
    sampled.forEach((item, n) => { item.picture = rows[n]; });
    seen.push(...read.items);
    texts += read.items.length;
    if (!read.pending) break;
    const moved = await timed(clock, 'scroll', () => page.evaluate(scrollOn, { step: Math.round(width.viewport.height * 0.8), beat: views.scroll_beat_ms }));
    if (!moved) break;
  }
  for (const item of seen) {
    const need = item.large ? t.contrast_aa_large : t.contrast_aa;
    if (item.disabled) {
      // A control that cannot be used is exempt from the contrast rule (WCAG 1.4.3); it is still read for the other probes.
    } else if (item.pixels) {
      const picture = item.picture;
      if (picture && picture.total > 0) {
        const ratio = Math.max(picture.best, 1);
        judge(item, ratio / t.pixel_slack, need, [picture.ground, picture.inkColour, item.observed], bar => `drawn contrast ${ratio.toFixed(2)} < ${bar} (${item.pixels}; ground ${rgb(picture.ground)}, brightest glyph pixel ${rgb(picture.inkColour)}, ${picture.ink} of ${picture.total} pixels differ from the ground; colour ${item.colourText})`);
      }
    } else if (item.observed && item.ground) {
      const ratio = contrastRatio(item.observed, item.ground);
      judge(item, ratio, need, [item.observed, item.ground], bar => `contrast ${ratio.toFixed(2)} < ${bar}: ${item.colourText} on ${rgb(item.ground)} (ground from ${item.groundSelector ?? 'the page canvas'})`);
    }
    if (item.clipped) add('overflow', item, `clipped by ${item.clipped.by}: text box ${item.clipped.text.join(',')} outside ${item.clipped.box.join(',')}`);
    if (item.scrolls) add('overflow', item, `${item.scrolls} with overflow hidden and no ellipsis or line-clamp`);
    if (item.outside) add('overflow', item, `text spans ${item.outside[0]}..${item.outside[1]}px in a ${item.outside[2]}px window`);
  }
  // Text the scrolled read judged from the picture (a graphic drawn under it, which the early read cannot see off-screen)
  // is judged there only: the early read's ground for it is the page behind the graphic, not what is under the words.
  const pictured = new Set(seen.filter(item => item.pixels).map(item => item.mark));
  for (const item of first) {
    if (pictured.has(item.mark)) continue;
    const ratio = contrastRatio(item.observed, item.ground);
    const need = item.large ? t.contrast_aa_large : t.contrast_aa;
    judge(item, ratio, need, [item.observed, item.ground], bar => `contrast ${ratio.toFixed(2)} < ${bar} before it scrolls into view: ${item.colourText} on ${rgb(item.ground)} (ground from ${item.groundSelector ?? 'the page canvas'})`);
  }
  await timed(clock, 'fonts', () => platformFonts({ page, held, cache: fontCache, items: seen }));
  const allowed = new Set([...fontsAllowed, ...views.always_allowed_fonts].map(name => name.toLowerCase()));
  const reported = new Set();
  const system = new Set(views.system_font_names ?? []);
  const systemOnly = item => item.fontFamily.split(',').every(name => system.has(name.trim().replace(/^["']|["']$/g, '').toLowerCase()));
  for (const item of seen) {
    if (systemOnly(item)) continue;
    const wrong = (fontCache.get(item.fontKey) ?? []).filter(font => !font.isCustomFont && !allowed.has(font.familyName.toLowerCase()));
    if (!wrong.length || reported.has(item.mark)) continue;
    reported.add(item.mark);
    add('font', item, `glyphs from ${wrong.map(font => font.familyName).join(', ')} drawn by a platform font; the screen declares ${[...fontsAllowed].join(', ') || 'no families'}`);
  }
  // Each item once per probe: the same text node found again by a later window is one finding.
  const kept = new Map();
  for (const failure of failures) kept.set(`${failure.probe}|${failure.selector}|${failure.text}`, failure);
  return { failures: [...kept.values()], texts };
}

async function drawFailures({ page, failures, file }) {
  await page.evaluate(marks => {
    const style = document.createElement('style');
    style.textContent = marks.map(mark => `[data-screen-matrix="${mark}"]{outline:2px solid #f00 !important}`).join('');
    document.head.append(style);
  }, failures.map(failure => failure.mark).filter(Boolean)).catch(() => {});
  await page.evaluate(() => { const root = document.scrollingElement; if (root) root.scrollTop = 0; }).catch(() => {});
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' }).catch(() => page.screenshot({ path: file }).catch(() => {}));
}

const matching = (allow, failure) => allow.find(row => ['screen', 'width', 'mode', 'probe', 'selector'].every(field => {
  if (row[field] == null) return true;
  const have = failure[field] ?? '';
  return row[field].endsWith('*') ? have.startsWith(row[field].slice(0, -1)) : have === row[field];
}));

/** Every screen at every width in every mode on `target`; see the header for the shapes. */
export async function runMatrix({ target, screens, views: base = readViews(), allowlist = readAllowlist(), only = {}, outDir = null, extension = null, say = () => {} }) {
  const started = Date.now();
  // A screens file may name views.json fields its own pages need otherwise (the app opens one page at a time, and slowly).
  const views = { ...base, ...screens.settings };
  const chosen = (rows, ids) => (ids?.length ? rows.filter(row => ids.includes(row.id)) : rows);
  const widths = chosen(views.widths, only.widths);
  const modes = chosen(views.modes, only.modes).filter(mode => !mode.extension || extension);
  const rows = chosen(screens.screens, only.screens);
  const defaults = screens.defaults ?? {};
  // One load of a screen at a width serves every mode that is only media emulation (apply "live": the page re-draws
  // for the new scheme with nothing reloaded); a mode that needs its own load (an init script, an extension) opens its own.
  const jobs = [];
  for (const row of rows) for (const width of widths) {
    if (row.widths && !row.widths.includes(width.id)) continue;
    const screen = { ...defaults, ...row, ready: row.ready ?? defaults.ready };
    const wanted = modes.filter(mode => !row.modes || row.modes.includes(mode.id));
    // A mode that changes the page itself (Dark Reader, switched on in the open page) is read after the modes that only change the media.
    const live = wanted.filter(mode => mode.apply === 'live').sort((a, b) => Number(!!a.darkreader) - Number(!!b.darkreader));
    if (live.length) jobs.push({ screen, width, modes: live });
    for (const mode of wanted.filter(mode => mode.apply !== 'live')) jobs.push({ screen, width, modes: [mode] });
  }
  const darkReader = widths.length && modes.some(mode => mode.darkreader) ? darkReaderSource() : null;
  const decoderContext = await target.newContext({ viewport: { width: 64, height: 64 } });
  const decoder = await decoderContext.newPage();
  await decoder.goto('about:blank');
  const results = [];
  const failures = [];
  const clock = {};
  const shotName = (screen, width, mode, suffix = '') => join(outDir, `${screen.id.replace(/[^a-z0-9-]+/gi, '_')}.${width.id}.${mode.id}${suffix}.png`);
  let next = 0;
  // A deploy's read has a budget (budget_ms): past it no further screen is opened and the run refuses with that reason,
  // so a build is told why instead of being stopped by its platform before it can say anything.
  let overBudget = false;
  const work = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      if (views.budget_ms && Date.now() - started > views.budget_ms) {
        if (!overBudget) failures.push({ screen: job.screen.id, width: job.width.id, mode: job.modes[0].id, probe: 'budget', selector: null, text: null, mark: null,
          detail: `the read passed its budget of ${Math.round(views.budget_ms / 1000)}s with ${jobs.length - next + 1} of ${jobs.length} screen loads not yet read` });
        overBudget = true;
        break;
      }
      const { screen, width, modes: group } = job;
      const first = group[0];
      const outcomes = [];
      for (let attempt = 1; attempt <= 2 && !outcomes.length; attempt += 1) {
        let context = null;
        let page = null;
        const held = {};
        const fontCache = new Map();
        const began = Date.now();
        try {
          await timed(clock, 'context', async () => {
            context = first.extension ? await extension.newContext(contextOptions(width, first)) : await target.newContext(contextOptions(width, first));
            if (target.prepare) await target.prepare(context);
          });
          if (first.darkreader && first.apply !== 'live') {
            await context.addInitScript({ content: darkReader });
            await context.addInitScript({ content: `(${(options) => { document.addEventListener('DOMContentLoaded', () => { window.DarkReader.setFetchMethod(window.fetch); window.DarkReader.enable(options); }, { once: true }); }})(${JSON.stringify(first.darkreader)})` });
          }
          page = await context.newPage();
          const watch = watchRequests(page);
          // A screen that did not open in time is opened once more: a busy machine stalls a page now and then, a broken screen stalls twice.
          await timed(clock, 'open', () => openScreen({ page, watch, mode: first, screen, origin: target.origin, views, say }).catch(error => {
            say(`  ${screen.id}/${width.id}: opened late (${String(error.message).split('\n')[0]}), trying once more`);
            return openScreen({ page, watch, mode: first, screen, origin: target.origin, views, say });
          }));
          const fontsAllowed = new Set((screen.fonts ?? []).map(String));
          for (const mode of group) {
            if (mode !== first || (mode.darkreader && mode.apply === 'live')) {
              await timed(clock, 'mode', async () => {
                await page.emulateMedia({ colorScheme: mode.colour_scheme ?? 'light', forcedColors: mode.forced_colors ?? 'none' });
                await page.evaluate(scrollToTop);
                if (mode.darkreader && mode.apply === 'live') {
                  await startDarkReader(page, darkReader, mode.darkreader);
                  await page.waitForFunction(() => document.querySelector('style.darkreader, style[data-darkreader-mode]') !== null, null, { timeout: 8000 });
                  await watch.quiet(views.idle_within_ms, views.quiet_ms);
                }
                await drawn(page, screen.settle_ms ?? views.settle_ms, views.animation_wait_ms);
              });
            }
            const read = await timed(clock, 'read', () => readScreen({ page, decoder, width, mode, screen, views, fontsAllowed, clock, held, fontCache }));
            // An allowlist row drops a proven false positive; a row with `decided` keeps the failure as reported, never refused.
            const found = read.failures.map(failure => ({ screen: screen.id, width: width.id, mode: mode.id, ...failure }))
              .map(failure => { const row = matching(allowlist, failure); return !row ? failure : row.decided ? { ...failure, decided: row.decided } : null; }).filter(Boolean);
            if (found.length && outDir) { mkdirSync(outDir, { recursive: true }); await timed(clock, 'shots', () => drawFailures({ page, failures: found, file: shotName(screen, width, mode) })); }
            outcomes.push({ mode, found, texts: read.texts, seconds: (Date.now() - began) / 1000 });
          }
        } catch (error) {
          outcomes.length = 0;
          if (attempt === 2) {
            for (const mode of group) outcomes.push({ mode, texts: 0, seconds: (Date.now() - began) / 1000,
              found: [{ screen: screen.id, width: width.id, mode: mode.id, probe: 'open', selector: null, text: null, detail: `${screen.route}: ${String(error?.message ?? error).split('\n')[0]}`, mark: null }] });
            if (outDir && page) { mkdirSync(outDir, { recursive: true }); await page.screenshot({ path: shotName(screen, width, first, '.did-not-open') }).catch(() => {}); }
          }
        } finally { await held.session?.detach().catch(() => {}); await context?.close().catch(() => {}); }
      }
      for (const outcome of outcomes) {
        failures.push(...outcome.found);
        const failing = outcome.found.filter(failure => failure.probe !== 'decided-colour' && !failure.decided).length;
        const decided = outcome.found.length - failing;
        results.push({ screen: screen.id, width: width.id, mode: outcome.mode.id, texts: outcome.texts, failures: failing, reported: decided, seconds: outcome.seconds });
        say(`  ${screen.id}/${width.id}/${outcome.mode.id}: ${outcome.texts} texts, ${failing} failing${decided ? `, ${decided} on a decided colour reported` : ''}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(only.pool ?? views.pool, availableParallelism(), jobs.length)) }, work));
  await decoderContext.close().catch(() => {});
  const seconds = (Date.now() - started) / 1000;
  // A decided look value that misses a bar is reported to the person, never a refusal (views.json decided_colours).
  const isDecided = failure => failure.probe === 'decided-colour' || Boolean(failure.decided);
  const reported = failures.filter(isDecided);
  const refusing = failures.filter(failure => !isDecided(failure));
  const report = { seconds, jobs: results.length, texts: results.reduce((sum, row) => sum + row.texts, 0), modes: modes.map(mode => mode.id), widths: widths.map(width => width.id), screens: rows.map(row => row.id), failures: refusing, reported, results, timing: Object.fromEntries(Object.entries(clock).map(([phase, ms]) => [phase, Math.round(ms) / 1000])) };
  return { failures: refusing, reported, report };
}

/** The short table printed after a run: failures counted per probe and mode and width, then the worst selectors. */
export function summarise({ failures, report }, say) {
  say(`screen-matrix: ${report.jobs} screen/width/mode views, ${report.texts} text nodes read in ${report.seconds.toFixed(1)}s`);
  if (report.timing) say(`screen-matrix: seconds per phase, summed over the parallel pages: ${Object.entries(report.timing).map(([phase, seconds]) => `${phase} ${seconds.toFixed(0)}`).join(', ')}`);
  if (report.reported?.length) {
    const views = new Set(report.reported.map(row => `${row.screen}/${row.width}/${row.mode}`));
    say(`screen-matrix: reported, not refused: ${report.reported.length} texts on a decided colour below its bar in ${views.size} views (${report.reported[0].detail.slice(0, 200)})`);
  }
  if (!failures.length) { say('screen-matrix: no failures'); return; }
  const count = (key) => { const table = new Map(); for (const failure of failures) table.set(key(failure), (table.get(key(failure)) ?? 0) + 1); return [...table].sort((a, b) => b[1] - a[1]); };
  say('probe               light  dark  forced  darkreader  ext   | phone  tablet  desktop');
  for (const [probe] of count(failure => failure.probe)) {
    const by = (field, id) => failures.filter(failure => failure.probe === probe && failure[field] === id).length;
    const cells = ['light', 'dark', 'forced', 'darkreader', 'darkreader-extension'].map(id => String(by('mode', id)).padStart(5));
    const sizes = ['phone', 'tablet', 'desktop'].map(id => String(by('width', id)).padStart(6));
    say(`${probe.padEnd(18)} ${cells.join(' ')}   | ${sizes.join(' ')}`);
  }
  say('worst offenders (probe, selector, views):');
  const worst = new Map();
  for (const failure of failures) {
    const key = `${failure.probe}  ${failure.selector ?? failure.screen}`;
    const entry = worst.get(key) ?? { n: 0, example: failure };
    entry.n += 1;
    worst.set(key, entry);
  }
  for (const [key, entry] of [...worst].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) say(`  ${String(entry.n).padStart(4)}  ${key}  [${entry.example.screen}/${entry.example.width}/${entry.example.mode}] ${(entry.example.text ?? '').slice(0, 40)} -- ${entry.example.detail.slice(0, 160)}`);
}

/** Open `origin` in a browser of this process: the target for a built folder served somewhere (a preview server, a Worker). */
export async function openOrigin({ origin, executablePath = undefined }) {
  const browser = await launchChromium({ headless: true, executablePath });
  return { origin, newContext: options => browser.newContext(options), close: () => browser.close(), browser };
}

/** A real unpacked extension (--extension DIR): contexts that carry it. Headless only, through Chromium's new headless mode. */
export async function openExtension({ dir, profile }) {
  const opened = [];
  return {
    newContext: async options => {
      // The slot is taken before the launch waits, so contexts opened in parallel never share a profile folder; each
      // folder starts empty, so a lock left by an earlier run cannot refuse it.
      const at = opened.push(null) - 1;
      const folder = join(profile, `ext-${at}`);
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      opened[at] = await launchPersistentChromium(folder, { channel: 'chromium', headless: true, ...options,
        args: [`--disable-extensions-except=${resolve(dir)}`, `--load-extension=${resolve(dir)}`] });
      return opened[at];
    },
  };
}

function argumentsOf(argv) {
  const out = {};
  for (let at = 0; at < argv.length; at += 1) if (argv[at].startsWith('--')) out[argv[at].slice(2)] = argv[at + 1];
  return out;
}

export async function main(argv = process.argv.slice(2), { openTarget = openOrigin } = {}) {
  const args = argumentsOf(argv);
  if (!args.screens || !args.origin) { process.stderr.write('usage: check-screens.mjs --origin URL --screens FILE [--only a,b] [--widths id,..] [--modes id,..] [--extension DIR] [--out DIR] [--report FILE] [--pool N]\n'); return 2; }
  const split = value => (value ? value.split(',') : undefined);
  const screens = JSON.parse(readFileSync(args.screens, 'utf8'));
  const target = await openTarget({ origin: args.origin });
  const extension = args.extension ? await openExtension({ dir: args.extension, profile: resolve(args.out ?? '.', '.extension-profiles') }) : null;
  try {
    const result = await runMatrix({ target, screens, extension, outDir: args.out ?? null, say: line => process.stdout.write(`${line}\n`),
      only: { screens: split(args.only), widths: split(args.widths), modes: split(args.modes), pool: args.pool ? Number(args.pool) : undefined } });
    summarise(result, line => process.stdout.write(`${line}\n`));
    if (args.report) { mkdirSync(dirname(resolve(args.report)), { recursive: true }); writeFileSync(args.report, JSON.stringify(result.report, null, 1)); }
    return result.failures.length ? 1 : 0;
  } finally { await target.close?.(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
