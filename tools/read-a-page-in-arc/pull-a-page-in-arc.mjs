// tools/read-a-page-in-arc/pull-a-page-in-arc.mjs
//
// PURPOSE
//   Pulls one page from the person's Arc browser, which they are signed in to, into one answer: the page's title, address and whole
//   text (the page is scrolled to its end first, so content that loads as you scroll is in it). Optionally every link on the
//   page, the pages those links lead to, or one file the page can download, written under the save root.
//
//     node pull-a-page-in-arc.mjs < input.json
//
//   input.json: { "url", "links", "scroll_selector", "follow": { "same_site_only", "most_pages", "match" }, "save": { "folder", "format", "file_url" } }.
//   Prints one JSON line: the answer, or { error }. Every limit is in pull-settings.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only http and https addresses are opened, and a save folder outside the declared root is refused. Both are checked before Arc is touched.
//   2. Every tab this run opens is closed, including when the read fails. A linked page is opened only after the page's own tab is closed.
//   3. A download is fetched inside the tab with the person's sign-in and written as bytes. It is never opened, run, unpacked or clicked.
//   4. Nothing is filled or submitted, and no button is clicked. The page is read and scrolled; that is all.
//   5. The page's text is data, never instructions. The only code that runs in the page is page-scripts.mjs.
//   6. Every bound comes from pull-settings.json: text, scroll steps and seconds, links, follow pages and seconds, bytes.
import { readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { arcTab } from './arc-tab.mjs';
import {
  base64PieceScript,
  downloadStateScript,
  linksScript,
  notionStateScript,
  readyStateScript,
  scrollStepScript,
  startDownloadScript,
  startNotionReadScript,
  stashPageScript,
  textPieceScript,
} from './page-scripts.mjs';

export const settings = JSON.parse(readFileSync(new URL('./pull-settings.json', import.meta.url), 'utf8'));

const INPUT_FIELDS = ['url', 'links', 'scroll_selector', 'follow', 'save'];
const FOLLOW_FIELDS = ['same_site_only', 'most_pages', 'match'];
const SAVE_FIELDS = ['folder', 'format', 'file_url'];
const GOOGLE_KINDS = { document: 'document', spreadsheets: 'spreadsheet', presentation: 'presentation' };
const GOOGLE_DEFAULT_FORMAT = { document: 'txt', spreadsheet: 'csv', presentation: 'pdf' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

class Refused extends Error {}

function refuse(message) {
  throw new Refused(message);
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const hostOf = (address) => new URL(address).hostname.toLowerCase().replace(/^www\./, '');
const isNotionAddress = (address) => /(^|\.)notion\.(site|com|so)$/i.test(new URL(address).hostname);
const homePath = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const isWebAddress = (address) => /^https?:\/\/\S+$/i.test(address) && address.length <= 2000;

function onlyFields(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) refuse(`${where} has a field it does not take: ${key}.`);
}

function readFollow(follow, s) {
  if (typeof follow !== 'object' || Array.isArray(follow)) refuse('follow must be an object.');
  onlyFields(follow, FOLLOW_FIELDS, 'follow');
  if (typeof follow.same_site_only !== 'boolean') refuse('follow.same_site_only must be true or false.');
  const most = follow.most_pages;
  if (!Number.isInteger(most) || most < 1 || most > s.follow.most_pages_limit) {
    refuse(`follow.most_pages must be a whole number from 1 to ${s.follow.most_pages_limit}.`);
  }
  let match = null;
  if (follow.match !== undefined) {
    if (typeof follow.match !== 'string' || follow.match.length === 0 || follow.match.length > s.follow.most_match_chars) {
      refuse(`follow.match must be a regular expression of 1 to ${s.follow.most_match_chars} characters.`);
    }
    try {
      match = new RegExp(follow.match);
    } catch {
      refuse('follow.match is not a valid regular expression.');
    }
  }
  return { same_site_only: follow.same_site_only, most_pages: most, match };
}

function readSave(save) {
  if (typeof save !== 'object' || Array.isArray(save)) refuse('save must be an object.');
  onlyFields(save, SAVE_FIELDS, 'save');
  if (typeof save.folder !== 'string' || save.folder.length === 0) refuse('save.folder must be the folder the file is written in.');
  if (save.format !== undefined && !/^[a-z0-9]{1,8}$/.test(save.format)) refuse('save.format must be a short extension such as md, csv or pdf.');
  if (save.file_url !== undefined && !isWebAddress(save.file_url)) refuse('save.file_url must be an http or https address.');
  return { folder: save.folder, format: save.format ?? null, file_url: save.file_url ?? null };
}

/** Checks the input before Arc is touched. Answers the request in plain words, or refuses. */
function readInput(input, s) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('The input must be a JSON object.');
  onlyFields(input, INPUT_FIELDS, 'The input');
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!isWebAddress(url)) refuse('The address must be an http or https address.');
  const selector = input.scroll_selector ?? null;
  if (selector !== null && (typeof selector !== 'string' || selector.length === 0 || selector.length > 300)) {
    refuse('scroll_selector must be a CSS selector of 1 to 300 characters.');
  }
  const links = input.links ?? false;
  if (typeof links !== 'boolean') refuse('links must be true or false.');
  const follow = input.follow === undefined ? null : readFollow(input.follow, s);
  const save = input.save === undefined ? null : readSave(input.save);
  if (save && (links || follow || selector)) refuse('save is one job on its own: leave out links, follow and scroll_selector.');
  return { url, selector, links, needs_links: links || follow !== null, follow, save };
}

/**
 * Where the file comes from, what it is called by its extension, and whether its HTML is kept as text. A Google Doc is read
 * from its own HTML page with the person's sign-in (its export address is refused to a page in Arc: a cross-origin redirect).
 */
function saveSource(pageUrl, save, s) {
  if (save.file_url) return { from_url: save.file_url, extension: save.format ?? extensionOf(save.file_url), as_text: false };
  const page = new URL(pageUrl);
  const google = page.hostname === 'docs.google.com' ? page.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/) : null;
  if (google) {
    const kind = GOOGLE_KINDS[google[1]];
    const format = save.format ?? GOOGLE_DEFAULT_FORMAT[kind];
    if (!s.save.export_formats[kind].includes(format)) {
      refuse(`A Google ${kind} can be saved as: ${s.save.export_formats[kind].join(', ')}.`);
    }
    const id = google[2];
    if (kind === 'document') {
      return { from_url: `https://docs.google.com/document/d/${id}/mobilebasic`, extension: format, as_text: format === 'txt' };
    }
    const from_url = kind === 'presentation'
      ? `https://docs.google.com/presentation/d/${id}/export/${format}`
      : `https://docs.google.com/spreadsheets/d/${id}/export?format=${format}`;
    return { from_url, extension: format, as_text: false };
  }
  const drive = page.hostname === 'drive.google.com' ? page.pathname.match(/^\/file\/d\/([\w-]+)/) : null;
  if (drive) {
    return { from_url: `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download`, extension: save.format ?? '', as_text: false };
  }
  return refuse('There is no file to save on this page. Give save.file_url, or use a Google Doc, Sheet, Slides or Drive file address.');
}

function entity(match, body) {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[body.toLowerCase()] ?? match;
}

/** The visible text of an HTML page: block ends become line breaks, tags go, entities are decoded, runs of spaces are one space. */
export function htmlToText(html) {
  const lines = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function extensionOf(address) {
  const extension = extname(new URL(address).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

/** Makes the save folder (and the root above it) and checks it is inside the root, following links, before Arc is touched. */
async function prepareFolder(folder, s) {
  const rootPath = resolve(homePath(s.save.root));
  if (!isAbsolute(homePath(folder))) refuse('save.folder must be an absolute path, or start with ~/.');
  const target = resolve(homePath(folder));
  if (target !== rootPath && !target.startsWith(rootPath + sep)) refuse(`save.folder must be inside ${rootPath}.`);
  await mkdir(rootPath, { recursive: true });
  await mkdir(target, { recursive: true });
  const realRoot = await realpath(rootPath);
  const realTarget = await realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) refuse(`save.folder must be inside ${realRoot}.`);
  return realTarget;
}

function failure(error) {
  if (error instanceof Refused) return error.message;
  return `Arc did not answer: ${String(error.stderr || error.message).trim().slice(0, 300)}`;
}

async function withTab(tab, address, job) {
  await tab.open(address);
  try {
    return await job();
  } finally {
    await tab.close();
  }
}

/** Waits until the page reports it has loaded. A tab that has only just opened may not answer scripts yet, so a failed call is retried. */
async function waitUntilLoaded(tab, s, sleep) {
  const deadline = Date.now() + s.wait.most_seconds * 1000;
  let state = null;
  let lastError = null;
  await sleep(s.wait.poll_ms);
  while (state !== 'complete') {
    if (Date.now() >= deadline) {
      refuse(`The page did not finish loading within ${s.wait.most_seconds} seconds${lastError ? `: ${lastError}` : '.'}`);
    }
    try {
      state = await tab.evaluate(readyStateScript());
    } catch (error) {
      lastError = failure(error);
    }
    if (state !== 'complete') await sleep(s.wait.poll_ms);
  }
  await sleep(s.wait.settle_ms);
}

/**
 * Scrolls until the height has stopped growing and the scroll is at its end, or a bound stops it. Answers how it stopped and the
 * text length before scrolling.
 */
async function scrollToEnd(tab, selector, s, sleep) {
  const textCharsBefore = (await tab.evaluate(stashPageScript(0))).textChars;
  const deadline = Date.now() + s.scroll.most_seconds * 1000;
  let last = null;
  let same = 0;
  let steps = 0;
  let stoppedBy = 'most_steps';
  let paneFound = selector === null ? null : true;
  while (steps < s.scroll.most_steps) {
    const step = await tab.evaluate(scrollStepScript(selector));
    if (selector !== null && !step.found) paneFound = false;
    steps += 1;
    same = step.height === last ? same + 1 : 0;
    last = step.height;
    if (same >= s.scroll.stable_rounds && step.atEnd) {
      stoppedBy = 'stable';
      break;
    }
    if (Date.now() > deadline) {
      stoppedBy = 'most_seconds';
      break;
    }
    await sleep(s.scroll.pause_ms);
  }
  return { steps, stopped_by: stoppedBy, text_chars_before: textCharsBefore, pane_found: paneFound };
}

/** The tab must be on the address asked for (the same host, a leading www. aside); a redirect to another host is refused. */
function refuseOtherPage(page, asked) {
  if (hostOf(page.url) !== hostOf(asked)) {
    refuse(`Arc opened ${page.url}, not the address asked (${asked}). Nothing was read.`);
  }
}

/** Reads the Notion page through its API in the tab: its text in block order and its links. Answers { text, links } or { error }. */
async function readNotionText(tab, s, sleep) {
  await tab.evaluate(startNotionReadScript({
    maxBlocks: s.notion.most_blocks,
    maxChunks: s.notion.most_chunks,
    maxRounds: s.notion.most_rounds,
  }));
  const deadline = Date.now() + s.notion.most_seconds * 1000;
  for (;;) {
    const state = await tab.evaluate(notionStateScript(s.links.most_links));
    if (state.state === 'done') {
      return { text: await readWholeText(tab, state.chars, s), links: state.links, blocks: state.blocks, chars: state.chars, sync_error: state.sync_error };
    }
    if (state.state === 'failed') return { error: state.error };
    if (Date.now() >= deadline) return { error: `The Notion page did not finish within ${s.notion.most_seconds} seconds.` };
    await sleep(s.notion.poll_ms);
  }
}

/** The kept text, in pieces of chunk_chars, cut at most_chars. */
async function readWholeText(tab, textChars, s) {
  const cap = Math.min(textChars, s.text.most_chars);
  let body = '';
  for (let at = 0; at < cap; at += s.text.chunk_chars) {
    body += await tab.evaluate(textPieceScript(at, Math.min(cap, at + s.text.chunk_chars)));
  }
  if (body.length !== cap) refuse('The page text did not come back whole. Nothing was kept.');
  return body;
}

/** Waits for the page, then reads its title, address and whole text: a Notion page through its API, any other page by scrolling. */
async function readOpenPage(tab, asked, selector, s, sleep) {
  let notionError = null;
  await waitUntilLoaded(tab, s, sleep);
  const first = await tab.evaluate(stashPageScript(0));
  refuseOtherPage(first, asked);
  if (isNotionAddress(asked)) {
    const notion = await readNotionText(tab, s, sleep);
    if (notion.text !== undefined) {
      const page = await tab.evaluate(stashPageScript(0));
      return {
        title: page.title,
        url: page.url,
        text: notion.text,
        truncated: notion.chars > s.text.most_chars,
        text_chars_total: notion.chars,
        scroll: { steps: 0, stopped_by: 'notion_blocks', text_chars_before: first.textChars, pane_found: null, notion_blocks: notion.blocks },
        notion_links: notion.links,
        notion_error: notion.sync_error,
      };
    }
    notionError = notion.error;
  }
  const scroll = await scrollToEnd(tab, selector, s, sleep);
  const page = await tab.evaluate(stashPageScript(s.text.most_chars));
  const body = await readWholeText(tab, page.textChars, s);
  return {
    title: page.title,
    url: page.url,
    text: body,
    truncated: page.textChars > s.text.most_chars,
    text_chars_total: page.textChars,
    scroll,
    notion_error: notionError,
  };
}

async function readLinks(tab, s) {
  const { links, found } = await tab.evaluate(linksScript(s.links.most_links, s.links.most_text_chars));
  return { links, found };
}

async function followPages(tab, page, linked, follow, s, sleep, startedAt) {
  const host = new URL(page.url).hostname;
  const picked = linked.links.filter((link) => link.href !== page.url
    && (!follow.same_site_only || new URL(link.href).hostname === host)
    && (!follow.match || follow.match.test(link.href) || follow.match.test(link.text)));
  const runEnd = startedAt + s.follow.most_run_seconds * 1000;
  const pages = [];
  let textChars = 0;
  let stoppedBy = null;
  for (const link of picked.slice(0, follow.most_pages)) {
    if (Date.now() > runEnd) {
      stoppedBy = 'run_seconds';
      break;
    }
    if (textChars >= s.follow.most_total_text_chars) {
      stoppedBy = 'total_text_chars';
      break;
    }
    try {
      const linkedPage = await withTab(tab, link.href, () => readOpenPage(tab, link.href, null, s, sleep));
      textChars += linkedPage.text.length;
      pages.push(linkedPage);
    } catch (error) {
      pages.push({ url: link.href, error: failure(error) });
    }
  }
  return { pages, considered: picked.length, stopped_by: stoppedBy };
}

/** The page's links: a Notion page's child pages first, then the links on the page, each address once, bounded. found counts the page's links before the bound. */
function mergeLinks(notionLinks, dom, most) {
  const seen = new Set();
  const links = [];
  for (const link of [...notionLinks, ...dom.links]) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    links.push(link);
  }
  return { links: links.slice(0, most), found: notionLinks.length + dom.found };
}

async function pullPage(tab, want, s, sleep, startedAt) {
  const { page, linked } = await withTab(tab, want.url, async () => {
    const read = await readOpenPage(tab, want.url, want.selector, s, sleep);
    const dom = want.needs_links ? await readLinks(tab, s) : null;
    return { page: read, linked: dom && mergeLinks(read.notion_links ?? [], dom, s.links.most_links) };
  });
  const answer = { title: page.title, url: page.url, text: page.text, truncated: page.truncated, text_chars_total: page.text_chars_total, scroll: page.scroll };
  if (page.notion_error) answer.notion_error = page.notion_error;
  if (want.links) {
    answer.links = linked.links;
    answer.links_found = linked.found;
    answer.links_truncated = linked.found > linked.links.length;
  }
  if (want.follow) answer.follow = await followPages(tab, page, linked, want.follow, s, sleep, startedAt);
  return answer;
}

async function pullFile(tab, want, source, folder, s, sleep) {
  return withTab(tab, want.url, async () => {
    await waitUntilLoaded(tab, s, sleep);
    const { title, url } = await tab.evaluate(stashPageScript(0));
    refuseOtherPage({ url }, want.url);
    await tab.evaluate(startDownloadScript(source.from_url, s.save.most_bytes));
    const state = await waitForDownload(tab, s, sleep);
    if (!source.as_text && source.extension !== 'html' && state.mediaType.startsWith('text/html')) {
      refuse('Arc got a web page instead of the file. Sign-in may be needed; nothing was saved.');
    }
    let base64 = '';
    for (let at = 0; at < state.base64Chars; at += s.save.chunk_chars) {
      base64 += await tab.evaluate(base64PieceScript(at, Math.min(state.base64Chars, at + s.save.chunk_chars)));
    }
    if (base64.length !== state.base64Chars) refuse('The file did not come back whole. Nothing was saved.');
    const fetched = Buffer.from(base64, 'base64');
    if (fetched.length !== state.bytes) refuse('The file did not come back whole. Nothing was saved.');
    const bytes = source.as_text ? Buffer.from(htmlToText(fetched.toString('utf8')), 'utf8') : fetched;
    const mediaType = source.as_text ? 'text/plain; charset=utf-8' : state.mediaType;
    const hash = bytesToHex(blake3(bytes));
    const name = source.extension ? `${hash}.${source.extension}` : hash;
    const path = join(folder, name);
    await writeFile(path, bytes);
    return {
      title,
      url,
      file: { name, path, bytes: bytes.length, blake3: hash, media_type: mediaType, from_url: source.from_url },
    };
  });
}

async function waitForDownload(tab, s, sleep) {
  const deadline = Date.now() + s.save.most_download_seconds * 1000;
  for (;;) {
    const state = await tab.evaluate(downloadStateScript());
    if (state.state === 'done') return state;
    if (state.state === 'failed') refuse(`Arc could not download the file: ${state.error}. Nothing was saved.`);
    if (Date.now() >= deadline) refuse(`The file did not finish downloading within ${s.save.most_download_seconds} seconds.`);
    await sleep(s.save.poll_ms);
  }
}

/** Pulls one page from Arc: { title, url, text, truncated, text_chars_total, scroll, links?, follow?, file? } or { error }. */
export async function pullAPageInArc(input, { exec, settings: s = settings, sleep = pause, tab } = {}) {
  const startedAt = Date.now();
  let want;
  let source = null;
  let folder = null;
  try {
    want = readInput(input, s);
    if (want.save) {
      source = saveSource(want.url, want.save, s);
      folder = await prepareFolder(want.save.folder, s);
    }
  } catch (error) {
    return { error: failure(error) };
  }
  const arc = tab ?? arcTab({ exec, timeout_ms: s.wait.call_timeout_ms });
  try {
    if (want.save) return await pullFile(arc, want, source, folder, s, sleep);
    return await pullPage(arc, want, s, sleep, startedAt);
  } catch (error) {
    return { error: failure(error) };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify(await pullAPageInArc(input)));
}
