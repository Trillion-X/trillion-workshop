// tools/publish-a-site-at-its-own-address/read-data/site-addresses.mjs
//
// Purpose: publish a site's files into the person's own files, give the site a readable name under the names host,
// attach the person's own domain to it, let an address go, and list the addresses: every change is one edit of the
// account's origins list, which the person's computer signs and hands to the forwarder.
//
// Non-Negotiable Invariants:
//   1. One list (`origins_file`) says which host shows which installation; this tool only edits it, whole.
//   2. A renamed site keeps its earlier name, sending page reads on to the new one (`moved_to`), never left to another
//      account while this one holds it. No address points at a moved address (the forwarder refuses a chain).
//   3. A name never looks like an installation id or a random code and never takes a reserved word (the forwarder
//      refuses the same names).
//   4. A domain is the person's own: it needs the TXT record naming their account, which this tool tells them.
//   5. Only the person's files are touched, through the run's own door and its rights.
//
// Ported from old trillion (tag old-trillion-before-worker-retire): src/public-app-names.mjs:79-83
// `checkedPublicAppName`, :85-92 `publicAppNameBasis`, :140-146 `retirePublicAppName` (moved_to);
// src/readable-names.mjs:47 LOOKS_LIKE_CODE, :54-59 `nameFromWords`; src/public-app-domains.mjs:36-41 `hostOf`, :44-52
// `describe`; src/share-link-routing.mjs:16-28 `normalizeShareDomain`. The old name and domain lists were central KV
// rows; here they are the account's own list.
import { randomBytes } from 'node:crypto';
import settings from './site-addresses.json' with { type: 'json' };
import { readWholeFile, writeWholeFile } from '../../records-door/read-data/whole-file.mjs';
import { checkedPublicAppFiles, publicAppMediaType } from '../../shared-code/src/public-app-files.mjs';
import { answerSiteLlms } from '../../choose-which-site-pages-ai-may-show/src/public-app-ai-pages.mjs';

const words = settings.words;
const names = settings;
const PATTERN = new RegExp(settings.pattern);
const LOOKS_LIKE_CODE = new RegExp(settings.code_pattern);
const RESERVED = new Set(settings.reserved);
const INSTALL = new RegExp(`^[0-9a-f]{${settings.installation_hex}}$`);
const ACCOUNT = /^[0-9a-f]{64}$/;

const refuse = message => { throw new Error(message); };

/**
 * A public name made from a thing's own words (old src/readable-names.mjs:54-59): the first `first` words, lowercased,
 * accents and punctuation dropped, joined by hyphens and cut to `longest`; null when nothing readable is left, the
 * result fails `pattern`, or it looks like a random code.
 */
export function nameFromWords(words, { first, longest, pattern }) {
  const slug = String(words ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, first).join('-')
    .slice(0, longest).replace(/-+$/, '');
  return pattern.test(slug) && !LOOKS_LIKE_CODE.test(slug) ? slug : null;
}

/** A name a person typed, checked; throws a plain refusal from public-app-names.json words. */
export function checkedPublicAppName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (!PATTERN.test(name) || name.includes('--') || INSTALL.test(name)) throw new Error(names.words.refused);
  if (RESERVED.has(name)) throw new Error(names.words.reserved);
  return name;
}

/** The app's name basis and where it came from: its page title, else the readable app id. */
export function publicAppNameBasis({ indexHtml = '', appId = '' } = {}) {
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(indexHtml)?.[1]
    ?.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&[a-z]+;/g, ' ').split(/\s[|·—–-]\s/)[0];
  const fromTitle = title && nameFromWords(title, { first: names.first_words, longest: names.longest, pattern: PATTERN });
  if (fromTitle && !RESERVED.has(fromTitle)) return { name: fromTitle, source: 'title' };
  const fromId = nameFromWords(String(appId).replace(/\b\d{6,}\b/g, ' '), { first: names.first_words, longest: names.longest, pattern: PATTERN });
  return fromId && !RESERVED.has(fromId) ? { name: fromId, source: 'fallback' } : null;
}


/** A name a person typed, checked: the old rule, and never code-shaped (the forwarder refuses the same names). */
export function checkedName(value) {
  const name = checkedPublicAppName(value);
  if (LOOKS_LIKE_CODE.test(name)) refuse(words.refused);
  return name;
}

/** A name made from words a person gave (a title), or null. */
export const nameFromTitle = text => {
  const name = nameFromWords(text, { first: names.first_words, longest: names.longest, pattern: PATTERN });
  return name && !RESERVED.has(name) ? name : null;
};

/** The name a site's own home page title gives (old publicAppNameBasis, from its title only), or null. */
export const nameFromPage = indexHtml => {
  const basis = publicAppNameBasis({ indexHtml: String(indexHtml ?? '') });
  return basis?.source === 'title' ? basis.name : null;
};

/** A domain the person gave, in its one form (old hostOf over normalizeShareDomain); never a name under the suffix. */
export function checkedDomain(value) {
  const given = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!given || /[/:@]/.test(given)) refuse(words.domain);
  if (given.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(given)) refuse(words.domain);
  const tld = given.split('.').at(-1);
  if (tld.length < 2 || /^\d+$/.test(tld)) refuse(words.domain);
  if (given === settings.suffix || given.endsWith(`.${settings.suffix}`)) refuse(words.domain_is_name);
  return given;
}

const checkedInstallation = value => INSTALL.test(String(value ?? '')) ? String(value) : refuse(words.installation);
const nameHost = name => `${name}.${settings.suffix}`;
const isName = host => host.endsWith(`.${settings.suffix}`);
const addressOf = host => `https://${host}/`;

/** The account's origins list, or an empty one when it keeps none yet. */
export async function readOrigins(door) {
  const listed = await door.files('list_files', { folder: `${settings.files_folder}/` });
  const named = (listed?.names ?? []).some(entry => (entry?.name ?? entry) === settings.origins_file);
  if (!named) return [];
  const { bytes } = await readWholeFile(door, settings.origins_file);
  const list = JSON.parse(Buffer.from(bytes ?? []).toString('utf8'));
  return Array.isArray(list?.origins) ? list.origins : [];
}

async function writeOrigins(door, origins) {
  if (origins.length > settings.most_origins) refuse(words.too_many);
  const sorted = [...origins].sort((a, b) => a.host.localeCompare(b.host));
  const bytes = Buffer.from(`${JSON.stringify({ origins: sorted }, null, 2)}\n`);
  await writeWholeFile(door, settings.origins_file, bytes, { mediaType: 'application/json', pieceBytes: settings.piece_bytes });
  return sorted;
}

const shown = origins => origins.map(({ host, installation, moved_to: movedTo }) =>
  ({ host, address: addressOf(host), installation, ...(movedTo ? { moved_to: movedTo } : {}) }));

/**
 * publish_site: keep a site's files under its installation in the person's files. `files` ({ path: text or data URL })
 * or `site` (the name of a site.json in the person's files, { files }); `installation` to publish a new version of a
 * site already published, else a new installation id.
 */
// A file named by its place in the person's Files (`{ from_files: "<name>" }`) is read from there, so its bytes never
// travel in the request. Its media type comes from its path, as every other file's does.
async function filesWithNamedBytes(files, door) {
  const out = {};
  for (const [path, content] of Object.entries(files)) {
    if (content !== null && typeof content === 'object' && typeof content.from_files === 'string') {
      const { bytes } = await readWholeFile(door, content.from_files);
      if (!bytes) refuse(words.from_files);
      out[path] = `data:${publicAppMediaType(path)};base64,${Buffer.from(bytes).toString('base64')}`;
    } else out[path] = content;
  }
  return out;
}

export async function publishSite(input = {}, { door, newId = () => randomBytes(settings.installation_hex / 2).toString('hex') } = {}) {
  let files = input.files;
  if (!files && typeof input.site === 'string') {
    const { bytes } = await readWholeFile(door, input.site);
    files = JSON.parse(Buffer.from(bytes ?? []).toString('utf8'))?.files;
  }
  if (!files || typeof files !== 'object') refuse(words.site);
  const checked = checkedPublicAppFiles(await filesWithNamedBytes(files, door));
  const installation = input.installation === undefined ? newId() : checkedInstallation(input.installation);
  let bytes = 0;
  for (const [path, file] of Object.entries(checked)) {
    await writeWholeFile(door, `${settings.files_folder}/${installation}/${path}`, Buffer.from(file.bytes),
      { mediaType: file.media_type, pieceBytes: settings.piece_bytes });
    bytes += file.size;
  }
  // A site that already has an address lists its pages for AI apps at /llms.txt (the AI page listing of
  // tools/choose-which-site-pages-ai-may-show, old trillion's site answer at that path), unless it ships its own.
  const live = (await readOrigins(door)).find(origin => origin.installation === installation && !origin.moved_to);
  let llms = false;
  if (live && !checked['llms.txt']) {
    const text = await siteLlms(checked, `https://${live.host}`, live.host);
    await writeWholeFile(door, `${settings.files_folder}/${installation}/llms.txt`, Buffer.from(text),
      { mediaType: 'text/plain; charset=utf-8', pieceBytes: settings.piece_bytes });
    llms = true;
  }
  const suggested = nameFromPage(Buffer.from(checked['index.html'].bytes).toString('utf8'));
  return { installation, files: Object.keys(checked).length, bytes, llms, ...(suggested ? { suggested_name: suggested } : {}) };
}

/** The site's AI page listing for `origin`, from its checked files in hand (no read of the person's files). */
export async function siteLlms(checked, origin, name) {
  const rows = Object.entries(checked).map(([path, file]) => ({ path, media_type: file.media_type })).sort((a, b) => a.path.localeCompare(b.path));
  const pages = {
    list: async () => ({ rows, cursor: null }),
    open: async path => checked[path] ? new Blob([checked[path].bytes]).stream() : null,
  };
  const answer = await answerSiteLlms(new Request(`${origin}/llms.txt`), { pages, origin, name });
  return answer.text();
}

async function published(door, installation) {
  const listed = await door.files('list_files', { folder: `${settings.files_folder}/${installation}/` });
  return (listed?.names ?? []).length > 0 || (listed?.folders ?? []).length > 0;
}

/**
 * name_site: the site's address under the names host: `name`, else one made from `title`. A site that had another name
 * keeps it, sending visitors on to the new one; a name it once had becomes its name again.
 */
export async function nameSite(input = {}, { door } = {}) {
  const installation = checkedInstallation(input.installation);
  const name = input.name !== undefined ? checkedName(input.name) : nameFromTitle(input.title) ?? refuse(words.no_name);
  if (!await published(door, installation)) refuse(words.not_published);
  const host = nameHost(name);
  const origins = await readOrigins(door);
  const held = origins.find(origin => origin.host === host);
  if (held && held.installation !== installation) refuse(words.taken);
  const earlier = origins.filter(origin => origin.installation === installation && isName(origin.host) && origin.host !== host && !origin.moved_to)
    .map(origin => origin.host);
  const next = origins.filter(origin => origin.host !== host).map(origin => {
    // Every earlier name of this site, and every name that was moved to one of them, now sends visitors here.
    if (origin.installation === installation && isName(origin.host) && (earlier.includes(origin.host) || earlier.includes(origin.moved_to))) {
      return { host: origin.host, installation, moved_to: host };
    }
    return origin;
  });
  next.push({ host, installation });
  const kept = await writeOrigins(door, next);
  return { address: addressOf(host), name, installation, renamed_from: earlier.map(addressOf), origins: shown(kept), said: words.live_when };
}

/**
 * attach_domain: the person's own domain shows the site. Answers the two DNS records to add: the TXT record naming the
 * account, and the address record pointing at the forwarder.
 */
export async function attachDomain(input = {}, { door } = {}) {
  const installation = checkedInstallation(input.installation);
  const host = checkedDomain(input.domain);
  const account = ACCOUNT.test(String(input.account ?? '')) ? input.account : refuse(words.account);
  if (!await published(door, installation)) refuse(words.not_published);
  const origins = await readOrigins(door);
  const held = origins.find(origin => origin.host === host);
  if (held && held.installation !== installation) refuse(words.taken);
  const kept = held ? origins : await writeOrigins(door, [...origins, { host, installation }]);
  return {
    address: addressOf(host),
    installation,
    records: [
      { type: 'TXT', name: `${settings.proof_label}.${host}`, value: `${settings.proof_value_prefix}${account}` },
      { type: 'CNAME', name: host, value: settings.points_at },
    ],
    origins: shown(kept),
    said: words.domain_when,
  };
}

/** let_go_of_address: the site stops answering at `host`, and every address moved to it goes with it. */
export async function letGo(input = {}, { door } = {}) {
  const host = String(input.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const origins = await readOrigins(door);
  if (!origins.some(origin => origin.host === host)) refuse(words.unknown_host);
  const kept = await writeOrigins(door, origins.filter(origin => origin.host !== host && origin.moved_to !== host));
  return { let_go: addressOf(host), origins: shown(kept) };
}

/**
 * What the forwarder last answered the list with, as the person's computer kept it (`told_file`): { state: answering,
 * hosts } or { state: refused, why }, with when; null before the computer handed the list in.
 */
export async function readTold(door) {
  const listed = await door.files('list_files', { folder: `${settings.files_folder}/` });
  if (!(listed?.names ?? []).some(entry => (entry?.name ?? entry) === settings.told_file)) return null;
  const { bytes } = await readWholeFile(door, settings.told_file);
  const told = JSON.parse(Buffer.from(bytes ?? []).toString('utf8'));
  const why = told?.state === 'refused' ? words.refusals[told.why] ?? told.why : null;
  return { state: told?.state ?? null, told_at: Number.isFinite(told?.told_at_ms) ? new Date(told.told_at_ms).toISOString() : null, ...(why ? { why } : {}) };
}

/** site_addresses: every address the person's sites answer at, where each was moved to, and what the forwarder said. */
export async function siteAddresses(_input = {}, { door } = {}) {
  return { origins: shown(await readOrigins(door)), told: await readTold(door) };
}
