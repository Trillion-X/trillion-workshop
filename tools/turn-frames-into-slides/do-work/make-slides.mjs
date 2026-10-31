// tools/turn-frames-into-slides/do-work/make-slides.mjs
//
// Turns a board's presentation frames into slides: one SVG per frame in story order, one printable HTML document and,
// with a browser, one PDF and a picture of every page. Run by the Workshop row `tool:turn-frames-into-slides` on the
// person's own computer:
//
//   node tools/turn-frames-into-slides/do-work/make-slides.mjs <request.json> --out <folder>
//        [--browser <chromium>, or BROWSER_EXECUTABLE] [--pdf] [--pictures]
//
// request.json (paths relative to it):
//   board          the board's items (a JSON file of [BoardItem] or { items }). A presentation frame is an item with
//                  extra.presentationFrame.order; every item centred inside it is on that slide.
//   title?         the document's title.
//   look_values?   a look's concrete values by variable name (tool:resolve-a-look's palette, a file or an object).
//                  Any style, colour or font in the board written as a variable name ("--accent-primary") is read
//                  from here; a name the look does not have stops the run.
//   look_css?      the look's stylesheet (tool:resolve-a-look --css), carried by the document so its faces draw.
//   assets?        { name: file or https address }. An item whose src is "asset:<name>" draws that asset; a file is
//                  carried in the document as its bytes.
//   frames?        [frame memberId] the slides to make, in this order. Absent: every frame, in its own order. One
//                  board can hold the pages of several decks; each deck's request names the ones it shows.
//   words_from?    a filled word template (tool:fill-a-word-template's piece) whose tokens name the board item they
//                  belong to (record): that item's text becomes the filled words.
//
// Writes slides/<NN>.svg, deck.html (pages of the frame size), and with --pdf deck.pdf, with --pictures
// pages/<NN>.png. Prints one JSON line { slides: [{ order, label, items, svg }], html, pdf?, pictures? }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardToDeck, deckToHtml } from '../read-data/board-deck.ts';
import { exportFillOf } from '../read-data/board-svg.ts';
import { boardFrames, itemsInsideFrame } from '../read-data/board-frames.ts';

const IMAGE_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'cornerRadius', 'opacity', 'textColor'];

function fail(message) {
  process.stderr.write(`make-slides: ${message}\n`);
  process.exit(2);
}

process.on('uncaughtException', error => fail(error.message));
process.on('unhandledRejection', error => fail(error?.message ?? String(error)));

function argsOf(argv) {
  const args = { request: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--browser') args.browser = argv[++i];
    else if (argv[i] === '--pdf') args.pdf = true;
    else if (argv[i] === '--pictures') args.pictures = true;
    else fail(`unknown argument ${argv[i]}.`);
  }
  if (!args.request || !args.out) fail('give the request and the output folder: make-slides.mjs <request.json> --out <folder>.');
  return args;
}

const readJson = (base, value) => (typeof value === 'string' ? JSON.parse(readFileSync(resolve(base, value), 'utf8')) : value);

/** A look value: a variable name is read from the look, anything else is used as written. */
function lookValue(values, value, where) {
  if (typeof value !== 'string' || !value.startsWith('--')) return value;
  if (!(value in values)) fail(`${where} names ${value}, which the look does not have.`);
  return values[value];
}

/** Text that shows a look's own value writes it as {{--name}} (a colour swatch's label), so the value is never copied. */
function lookValuesInText(values, text, where) {
  return typeof text === 'string' ? text.replace(/\{\{(--[a-z0-9-]+)\}\}/g, (_, name) => lookValue(values, name, where)) : text;
}

/** Each item's text from a filled word template: its tokens in order, a line break where the template kept one. */
function textsFromPiece(piece) {
  const texts = new Map();
  for (const token of piece.tokens ?? []) {
    if (!token.record) continue;
    const word = Object.values(token.dims ?? {}).find(value => typeof value === 'string');
    if (word === undefined) continue;
    const before = texts.get(token.record);
    if (word === '↵') texts.set(token.record, `${before ?? ''}\n`);
    else texts.set(token.record, before === undefined || before.endsWith('\n') ? `${before ?? ''}${word}` : `${before} ${word}`);
  }
  return texts;
}

function assetSource(base, assets, src, where) {
  if (typeof src !== 'string' || !src.startsWith('asset:')) return src;
  const name = src.slice('asset:'.length);
  const asset = assets?.[name];
  if (typeof asset !== 'string' || !asset) fail(`${where} draws asset ${name}, which the request's assets do not name.`);
  if (/^https:\/\//i.test(asset)) return asset;
  const file = isAbsolute(asset) ? asset : resolve(base, asset);
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) fail(`asset ${name} is ${file}: an asset file is .svg, .png, .jpg or .webp.`);
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

/** The board's items as the exporter reads them, with look values, assets and filled words in place. */
export function prepareItems(rawItems, { values = {}, assets = {}, texts = new Map(), base = '.' } = {}) {
  return rawItems.map(raw => {
    if (!raw?.memberId) fail('every board item needs a memberId.');
    const where = `item ${raw.memberId}`;
    const extra = { ...(raw.extra ?? {}) };
    if (extra.fontFamily) extra.fontFamily = lookValue(values, extra.fontFamily, where);
    if (extra.style) extra.style = Object.fromEntries(Object.entries(extra.style).map(([key, value]) => [key, lookValue(values, value, where)]));
    return {
      kind: 'note', isSection: false, childCount: 0, nodeRef: { id: raw.memberId }, ...raw, extra,
      text: lookValuesInText(values, texts.has(raw.memberId) ? texts.get(raw.memberId) : raw.text, where),
      src: assetSource(base, assets, raw.src, where),
    };
  });
}

/** Only the named frames stay frames, ordered as named; a frame not named is no slide, so nothing inside it shows. */
export function chooseFrames(items, ids) {
  if (ids === undefined) return items;
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) fail('frames is a list of frame memberIds.');
  const frameIds = new Set(boardFrames(items).map(frame => frame.memberId));
  for (const id of ids) if (!frameIds.has(id)) fail(`frames names ${id}, which is not a frame on the board.`);
  const order = new Map(ids.map((id, index) => [id, index + 1]));
  return items.map(item => {
    if (!frameIds.has(item.memberId)) return item;
    const { presentationFrame, ...extra } = item.extra;
    return { ...item, extra: order.has(item.memberId) ? { ...extra, presentationFrame: { ...presentationFrame, order: order.get(item.memberId) } } : extra };
  });
}

/** An item's own style (extra.style), else the board exporter's own resolver. */
export function slideFillOf(item) {
  const style = item.extra?.style;
  if (!style || typeof style !== 'object') return exportFillOf(item);
  return Object.fromEntries(STYLE_KEYS.filter(key => style[key] !== undefined).map(key => [key, style[key]]));
}

async function printDeck(htmlPath, browserPath, page, slideCount, { pdf, pictures }, out) {
  // The browser library is loaded only when a page is printed or pictured: slides alone need no browser.
  const { openBrowser } = await import('../../headless-browser/devtools.mjs');
  const browser = await openBrowser(browserPath, page);
  try {
    await browser.send('Page.enable');
    const loaded = new Promise(done => browser.on(event => { if (event.method === 'Page.loadEventFired') done(); }));
    await browser.send('Page.navigate', { url: pathToFileURL(htmlPath).href });
    await loaded;
    // The look's faces must be drawn before any page is printed or pictured.
    await browser.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => document.fonts.size)', awaitPromise: true });
    const made = {};
    if (pdf) {
      const { data } = await browser.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
      made.pdf = join(out, 'deck.pdf');
      writeFileSync(made.pdf, Buffer.from(data, 'base64'));
    }
    if (pictures) {
      mkdirSync(join(out, 'pages'), { recursive: true });
      made.pictures = [];
      for (let i = 0; i < slideCount; i += 1) {
        const { data } = await browser.send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, clip: { x: 0, y: i * page.height, width: page.width, height: page.height, scale: 1 },
        });
        const file = join(out, 'pages', `${String(i + 1).padStart(2, '0')}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        made.pictures.push(file);
      }
    }
    return made;
  } finally {
    browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = argsOf(process.argv.slice(2));
  const base = dirname(resolve(args.request));
  const request = readJson(base, args.request);
  const board = readJson(base, request.board);
  const rawItems = Array.isArray(board) ? board : board?.items;
  if (!Array.isArray(rawItems)) fail('board is a list of items, or { items }.');
  const values = request.look_values ? readJson(base, request.look_values) : {};
  const palette = values.palette ?? values;
  const texts = request.words_from ? textsFromPiece(readJson(base, request.words_from)) : new Map();
  const items = chooseFrames(prepareItems(rawItems, { values: palette, assets: request.assets, texts, base }), request.frames);
  const frames = boardFrames(items);
  if (!frames.length) fail('the board has no presentation frames: give a frame extra.presentationFrame.order.');
  const page = { width: frames[0].w, height: frames[0].h };
  for (const frame of frames) if (frame.w !== page.width || frame.h !== page.height) fail(`frame ${frame.memberId} is ${frame.w} x ${frame.h}; every slide is ${page.width} x ${page.height}.`);

  const deck = boardToDeck(items, { padding: 0, fillOf: slideFillOf, fontFamily: lookValue(palette, request.font ?? '--font-primary', 'request.font') });
  const words = frames.flatMap((frame, index) => itemsInsideFrame(items, frame)
    .filter(item => typeof item.text === 'string' && item.text.trim())
    .map(item => ({ id: item.memberId, text: item.text, slide: index + 1 })));
  const css = request.look_css ? readFileSync(resolve(base, request.look_css), 'utf8') : '';
  const out = resolve(args.out);
  mkdirSync(join(out, 'slides'), { recursive: true });
  const slides = deck.slides.map(slide => {
    const file = join(out, 'slides', `${String(slide.order).padStart(2, '0')}.svg`);
    writeFileSync(file, slide.svg);
    return { order: slide.order, label: slide.label, items: slide.itemCount, svg: file };
  });
  const html = join(out, 'deck.html');
  writeFileSync(html, deckToHtml(deck, { title: request.title, page, css, words }));
  const made = args.pdf || args.pictures
    ? await printDeck(html, args.browser || process.env.BROWSER_EXECUTABLE || 'chromium', page, slides.length, args, out)
    : {};
  console.log(JSON.stringify({ slides, html, ...made }));
}
