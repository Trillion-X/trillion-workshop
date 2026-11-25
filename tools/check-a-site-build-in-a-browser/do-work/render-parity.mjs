// tools/check-a-site-build-in-a-browser/do-work/render-parity.mjs
//
// PURPOSE
//   Says, element by element, how a page drawn one way differs from the same page drawn another (an old program's page and the
//   page the rows draw), at each window width asked: the words, the words drawn in another colour inside a heading (the
//   highlight), each text's size, weight, colour, line height, alignment, box width and left edge, the gap down to the text before
//   it, the headings and landmarks, and anything that runs past the window's width. The count of differences is the answer: 0 is
//   parity. `compareRenders` takes two page openers and gives the counts and every difference with where it was found; the
//   command (see the foot) opens two addresses.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here is specific to one site: it reads what the browser computed, never a selector or a word of a site.
//   2. A difference is stated with both values, the text it was found at and the width, so it can be fixed in the part that
//      draws it; a difference the tolerances (settings below) allow is not counted.
//   3. Texts are matched by their words in reading order (longest common run), so a missing or extra text is one difference
//      and does not move every later one.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { writeFileSync } from 'node:fs';

export const TOLERANCE = { px: 2, size: 0.5, gap: 4 };

// Runs in the page: every visible text leaf and picture, in reading order, with what the browser computed for it.
function collect() {
  const norm = value => value.replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  const visible = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let prevBottom = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = norm(node.nodeValue ?? '');
    const element = node.parentElement;
    if (!text || !element || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName) || !visible(element)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0) continue;
    const style = getComputedStyle(element);
    const parentStyle = element.parentElement ? getComputedStyle(element.parentElement) : style;
    const block = element.closest('h1,h2,h3,h4,h5,h6,p,li,button,a,label,figcaption,blockquote,div') ?? element;
    const heading = element.closest('h1,h2,h3,h4,h5,h6');
    const key = `${text}@${Math.round(box.top)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const blockBox = block.getBoundingClientRect();
    out.push({
      text,
      tag: element.tagName.toLowerCase(),
      heading: heading ? heading.tagName.toLowerCase() : null,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      color: style.color,
      accent: heading !== null && style.color !== parentStyle.color,
      lineHeight: style.lineHeight === 'normal' ? 'normal' : parseFloat(style.lineHeight),
      textAlign: style.textAlign,
      fontFamily: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      left: Math.round(box.left),
      width: Math.round(blockBox.width),
      right: Math.round(box.right),
      top: Math.round(box.top + scrollY),
      gap: prevBottom === null ? null : Math.round(box.top + scrollY - prevBottom),
    });
    prevBottom = box.bottom + scrollY;
  }
  const pictures = [...document.querySelectorAll('img,video,canvas,svg')].filter(visible).map(element => {
    const box = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height), top: Math.round(box.top + scrollY) };
  }).filter(item => item.width >= 24 && item.height >= 24);
  const wide = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('body *')].filter(visible).map(element => ({ element, box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.right > wide + 1 || box.left < -1)
    .filter(({ element }) => {
      // An element scrolled sideways inside its own box is meant to run on; count only the ones whose scrolling parent is the page.
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden' || overflow === 'clip') return false;
      }
      return true;
    })
    .slice(0, 12).map(({ element, box }) => ({ tag: element.tagName.toLowerCase(), text: norm(element.textContent ?? '').slice(0, 50), left: Math.round(box.left), right: Math.round(box.right) }));
  return {
    texts: out,
    pictures,
    headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map(element => `${element.tagName.toLowerCase()}:${norm(element.textContent ?? '').slice(0, 40)}`),
    h1: document.querySelectorAll('h1').length,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: wide,
    scrollHeight: document.documentElement.scrollHeight,
    over,
  };
}

// The longest common run of two lists by key (reading order), as pairs of indexes.
export function alignBy(a, b, key = item => item.text) {
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i][j] = key(a[i]) === key(b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) { pairs.push([i, j]); i += 1; j += 1; } else if (table[i + 1][j] >= table[i][j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

const near = (x, y, by) => Math.abs(x - y) <= by;

// The differences between two collected pages at one width.
export function differences(old, now, width, tolerance = TOLERANCE) {
  const found = [];
  const add = (kind, where, was, is) => found.push({ width, kind, where, was, is });
  const pairs = alignBy(old.texts, now.texts);
  const inOld = new Set(pairs.map(([i]) => i)), inNew = new Set(pairs.map(([, j]) => j));
  old.texts.forEach((item, i) => { if (!inOld.has(i)) add('text missing', item.text.slice(0, 60), `${item.tag} ${item.fontSize}px`, null); });
  now.texts.forEach((item, j) => { if (!inNew.has(j)) add('text added', item.text.slice(0, 60), null, `${item.tag} ${item.fontSize}px`); });
  let previous = null;
  for (const [i, j] of pairs) {
    const a = old.texts[i], b = now.texts[j], where = a.text.slice(0, 60);
    if (!near(a.fontSize, b.fontSize, tolerance.size)) add('font size', where, a.fontSize, b.fontSize);
    if (a.fontWeight !== b.fontWeight) add('font weight', where, a.fontWeight, b.fontWeight);
    if (a.color !== b.color) add('colour', where, a.color, b.color);
    if (a.fontFamily !== b.fontFamily) add('font family', where, a.fontFamily, b.fontFamily);
    // A button or link centres its words by its own flex box, so its text-align says nothing about how it looks.
    if (!['a', 'button'].includes(a.tag) && a.textAlign !== b.textAlign && !['start', 'left'].includes(a.textAlign) !== !['start', 'left'].includes(b.textAlign)) add('alignment', where, a.textAlign, b.textAlign);
    if (a.lineHeight !== b.lineHeight && !(typeof a.lineHeight === 'number' && typeof b.lineHeight === 'number' && near(a.lineHeight, b.lineHeight, 1.5))) add('line height', where, a.lineHeight, b.lineHeight);
    if (!near(a.left, b.left, tolerance.px)) add('left edge', where, a.left, b.left);
    if (!near(a.width, b.width, tolerance.px * 2)) add('box width', where, a.width, b.width);
    if (a.accent !== b.accent) add('highlight', where, a.accent, b.accent);
    if ((a.heading ?? '') !== (b.heading ?? '')) add('heading level', where, a.heading, b.heading);
    if (previous && a.gap !== null && b.gap !== null && previous.i + 1 === i && previous.j + 1 === j && !near(a.gap, b.gap, tolerance.gap)) add('gap above', where, a.gap, b.gap);
    previous = { i, j };
  }
  if (old.h1 !== now.h1) add('h1 count', 'page', old.h1, now.h1);
  const pictureAt = (list) => list.map(item => `${item.tag}:${item.width}x${item.height}`);
  const pic = alignBy(pictureAt(old.pictures).map(text => ({ text })), pictureAt(now.pictures).map(text => ({ text })));
  if (pic.length < Math.max(old.pictures.length, now.pictures.length) * 0.9) add('pictures', 'page', `${old.pictures.length} drawn`, `${now.pictures.length} drawn, ${pic.length} the same size`);
  if (now.scrollWidth > now.clientWidth + 1 && old.scrollWidth <= old.clientWidth + 1) add('runs past the window', 'page', old.scrollWidth, now.scrollWidth);
  for (const item of now.over) if (!old.over.some(other => other.text === item.text)) add('runs past the window', `${item.tag} ${item.text}`, null, `${item.left}..${item.right} of ${now.clientWidth}`);
  if (!near(old.scrollHeight, now.scrollHeight, Math.max(40, old.scrollHeight * 0.02))) add('page height', 'page', old.scrollHeight, now.scrollHeight);
  return found;
}

/** Opens both pages at each width and returns { count, byKind, differences, pictures }. */
export async function compareRenders({ browser, old, now, widths = [1280, 390], height = 900, settleMs = 1500, shots = null }) {
  const all = [];
  for (const width of widths) {
    const rendered = [];
    for (const [name, open] of [['old', old], ['new', now]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await open(page);
      await page.waitForTimeout(settleMs);
      // Lazy parts draw when scrolled to: walk the page once, then back to the top.
      await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 700) { scrollTo(0, y); await new Promise(done => setTimeout(done, 120)); } scrollTo(0, 0); });
      await page.waitForTimeout(400);
      rendered.push(await page.evaluate(collect));
      if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
      await context.close();
    }
    all.push(...differences(rendered[0], rendered[1], width));
  }
  const byKind = {};
  for (const item of all) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return { count: all.length, byKind, differences: all };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // node render-parity.mjs OLD_URL NEW_URL OUT_DIR [widths]  (an old address may be a local one serving the old page)
  const { createRequire } = await import('node:module');
  const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${process.cwd()}/package.json`);
  const { chromium } = require('playwright');
  const [oldUrl, newUrl, out, widthsText] = process.argv.slice(2);
  const browser = await chromium.launch();
  const opener = url => async page => { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); };
  const result = await compareRenders({ browser, old: opener(oldUrl), now: opener(newUrl), widths: (widthsText ?? '1280,390').split(',').map(Number), shots: out });
  await browser.close();
  writeFileSync(`${out}/parity.json`, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ count: result.count, byKind: result.byKind }));
}
