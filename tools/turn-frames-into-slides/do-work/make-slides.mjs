// tools/turn-frames-into-slides/do-work/make-slides.mjs
//
// Turns a board's presentation frames into slides: one SVG per frame in story order, one printable HTML document and,
// with a browser, one PDF and a picture of every page. Run by the Workshop row `tool:turn-frames-into-slides` on the
// person's own computer:
//
//   node tools/turn-frames-into-slides/do-work/make-slides.mjs <request.json> [--out <folder>]
//        [--browser <chromium>, or BROWSER_EXECUTABLE] [--pdf] [--pictures] [--keep]
//
// The request is either the file's own object, or a workflow step's input { request, out? }: request is that object
// inline or a path to a file of it (paths inside it are relative to the file), out is the folder (--out wins).
// --keep also keeps the PDF in the person's Files under /Slides and prints its Files name as pdf (see keepInFiles).
//
// request (paths relative to the request file):
//   board          the board's items (a JSON file of [BoardItem] or { items }). A presentation frame is an item with
//                  extra.presentationFrame.order; every item centred inside it is on that slide.
//   slides         instead of board: the deck as slides (what each says and shows), laid out onto a board by
//                  do-work/slides-to-board.mjs (kinds words, compare, picture, table). Give board or slides, not both.
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
//   words_rules?   the person's own rule rows (tools/judge-words rows, a file or a list), judged with the shipped rows of
//                  read-data/words-a-reader-sees.json. Every line on a slide is judged before anything is drawn; a line
//                  that breaks a row stops the run with each finding, so no deck leaves this tool with those words.
//
// Writes slides/<NN>.svg, deck.html (pages of the frame size), and with --pdf deck.pdf, with --pictures
// pages/<NN>.png. Prints one JSON line { slides: [{ order, label, items, svg }], html, pdf?, pictures? }, where pdf is
// the PDF's name in the person's Files with --keep.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { boardToDeck, deckToHtml } from '../../organize-the-sidebar/do-work/board-deck.ts';
import { exportFillOf } from '../../organize-the-sidebar/do-work/board-svg.ts';
import { boardFrames, itemsInsideFrame } from '../../organize-the-sidebar/do-work/board-frames.ts';
import { judge } from '../../judge-words/do-work/judge-words.mjs';
import { slidesToBoard } from './slides-to-board.mjs';

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
    else if (argv[i] === '--keep') args.keep = true;
    else fail(`unknown argument ${argv[i]}.`);
  }
  if (!args.request) fail('give the request: make-slides.mjs <request.json> [--out <folder>].');
  if (args.keep) args.pdf = true;
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

const LABEL_SHARE = 0.8; // a line at most this share of the slide's largest words, above them, is a label
const LABEL_WORDS = 12;

/** Each line of one slide as the judge reads it: a short line set smaller than the slide's largest words and placed
 * wholly above them is a label above the title; every other line is slide words. */
export function slideLines(items, slide) {
  const sized = items.filter(item => Number.isFinite(item.extra?.fontSize));
  const largest = sized.reduce((top, item) => (top && top.extra.fontSize >= item.extra.fontSize ? top : item), null);
  return items.map(item => {
    const label = largest && item !== largest && Number.isFinite(item.extra?.fontSize)
      && item.extra.fontSize <= largest.extra.fontSize * LABEL_SHARE && item.y + item.h <= largest.y
      && item.text.trim().split(/\s+/).length <= LABEL_WORDS;
    return { id: item.memberId, slide, text: item.text, kind: label ? 'label-above-title' : 'slide-words' };
  });
}

/** The findings that stop a deck: every line judged against the shipped rows and the person's own. */
export function wordFindings(lines, personRules = []) {
  const shipped = JSON.parse(readFileSync(new URL('../read-data/words-a-reader-sees.json', import.meta.url), 'utf8')).rules;
  const rules = [...shipped, ...personRules];
  const result = judge({ rules, items: lines.map(line => ({ text: line.text, kind: line.kind, id: line.id })) });
  return result.findings.filter(finding => finding.at_most === undefined).map(finding => {
    const line = lines.find(candidate => candidate.text === finding.text);
    return { ...finding, slide: line?.slide, item: line?.id };
  });
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

const FILES_FOLDER = '/Slides';
const PIECE_MOST_BYTES = 33554432;

/** Keeps a local file in the person's Files as /Slides/<title>-<identity>.pdf, the way the other on-your-computer tools keep
 *  theirs (tools/track-and-compare-movement/do-work/files_road.py): write_file_start, one raw piece (op --upload),
 *  write_file_finish, then find_file, whose identity and length must be the file's. The name carries the identity, so a
 *  retried keep finds the same file. `call` is the command that runs one engine operation: WORKSHOP_CLI names it when `call` is absent (the run fails without it); WF_PIN, when
 *  a workflow run set it, names the computer that holds the Files right. Returns the name. */
export function keepInFiles(path, { title, call = [process.env.WORKSHOP_CLI], pin = process.env.WF_PIN } = {}) {
  if (!call[0]) fail('keep needs the signed-in command: set WORKSHOP_CLI to it.');
  const bytes = readFileSync(path);
  if (bytes.length > PIECE_MOST_BYTES) fail(`${path} is ${bytes.length} bytes; one piece holds at most ${PIECE_MOST_BYTES}.`);
  const identity = makeHashCodeHexFromBytes(bytes);
  const slug = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
  const name = `${FILES_FOLDER}/${slug}-${identity.slice(3, 15)}.pdf`;
  const upload_id = identity.slice(3, 35);
  const op = (structured, upload) => {
    const args = [...call.slice(1), 'op', 'tools:run', JSON.stringify({ tool: 'tool:your-files', call: { name: structured.name, arguments: structured.arguments } })];
    if (pin) args.push('--pin', pin);
    if (upload) args.push('--upload', upload);
    const reply = JSON.parse(execFileSync(call[0], args, { encoding: 'utf8', maxBuffer: 1 << 20 }));
    return reply.result?.structuredContent ?? {};
  };
  const started = op({ name: 'write_file_start', arguments: { upload_id, name, byte_length: bytes.length, media_type: 'application/pdf', app: 'tool:turn-frames-into-slides' } });
  if (started.state === 'open') {
    const piece = op({ name: 'write_file_piece', arguments: { upload_id, name, offset: 0 } }, path);
    if (piece.next_offset !== bytes.length) fail(`the Files store took ${piece.next_offset} of ${bytes.length} bytes of ${name}; nothing is kept.`);
    op({ name: 'write_file_finish', arguments: { upload_id, name, identity } });
  } else if (started.state !== 'finished') {
    fail(`the Files store did not open ${name} (state ${started.state ?? 'unknown'}).`);
  }
  const found = op({ name: 'find_file', arguments: { name_or_identity: name } });
  if (found.identity !== identity || found.byte_length !== bytes.length) fail(`${name} does not read back as ${identity}.`);
  return name;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = argsOf(process.argv.slice(2));
  const base = dirname(resolve(args.request));
  const given = readJson(base, args.request);
  // A workflow step's input is the whole file: { request, out }, with request inline or a path; a request file is itself the request.
  const envelope = given.request !== undefined;
  const request = envelope ? readJson(base, given.request) : given;
  if (!request || typeof request !== 'object') fail('request is the request object, or a path to a file of it.');
  if (Boolean(request.board) === Boolean(request.slides)) fail('give the deck as a board or as slides, one of the two.');
  const laidOut = request.slides ? slidesToBoard(readJson(base, request.slides)) : null;
  const board = laidOut ?? readJson(base, request.board);
  const rawItems = Array.isArray(board) ? board : board?.items;
  if (!Array.isArray(rawItems)) fail('board is a list of items, or { items }.');
  if (laidOut) request.assets = { ...laidOut.assets, ...(request.assets ?? {}) };
  const values = request.look_values ? readJson(base, request.look_values) : {};
  const palette = values.palette ?? values;
  const texts = request.words_from ? textsFromPiece(readJson(base, request.words_from)) : new Map();
  const items = chooseFrames(prepareItems(rawItems, { values: palette, assets: request.assets, texts, base }), request.frames);
  const frames = boardFrames(items);
  if (!frames.length) fail('the board has no presentation frames: give a frame extra.presentationFrame.order.');
  const page = { width: frames[0].w, height: frames[0].h };
  for (const frame of frames) if (frame.w !== page.width || frame.h !== page.height) fail(`frame ${frame.memberId} is ${frame.w} x ${frame.h}; every slide is ${page.width} x ${page.height}.`);

  const lines = frames.flatMap((frame, index) => slideLines(itemsInsideFrame(items, frame)
    .filter(item => typeof item.text === 'string' && item.text.trim()), index + 1));
  const personRules = request.words_rules ? readJson(base, request.words_rules) : [];
  if (!Array.isArray(personRules)) fail('words_rules is a list of rule rows (tools/judge-words), or a file of one.');
  const broken = wordFindings(lines, personRules);
  if (broken.length) {
    fail(`the words on ${new Set(broken.map(finding => finding.slide)).size} slide(s) break the reader's rules, so nothing was drawn:\n${broken
      .map(finding => `  slide ${finding.slide} (${finding.item}) ${finding.rule}: "${finding.text}". ${finding.says} ${finding.suggest ?? ''}`.trimEnd()).join('\n')}`);
  }

  const deck = boardToDeck(items, { padding: 0, fillOf: slideFillOf, fontFamily: lookValue(palette, request.font ?? '--font-primary', 'request.font') });
  const words = frames.flatMap((frame, index) => itemsInsideFrame(items, frame)
    .filter(item => typeof item.text === 'string' && item.text.trim())
    .map(item => ({ id: item.memberId, text: item.text, slide: index + 1 })));
  const css = request.look_css ? readFileSync(resolve(base, request.look_css), 'utf8') : '';
  const out = args.out ? resolve(args.out) : resolve(base, (envelope && given.out) || 'deck');
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
  if (args.keep) made.pdf = keepInFiles(made.pdf, { title: request.title });
  console.log(JSON.stringify({ slides, html, ...made }));
}
