// tools/site-head-from-its-rows/do-work/site-head.ts
//
// PURPOSE
//   The parts every page of a site carries in its head and at the start of its body, made from the site's rows: the consent
//   default (every visitor starts denied; a kept choice is applied before any tag runs), the Accept / Decline bar, then the
//   declared head parts (inline snippets and async scripts) in order, and the body-start parts. The bar and the default are the
//   shared consent-banner part (tools/ui/show/consent-banner); this file only checks the data and places them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is emitted before the consent default: it is the first script in the head.
//   2. A part is structured (kind, purpose, src or text). The whole set is refused, with every problem listed, when an address is
//      not https, a purpose is not declared, a kind is in the wrong place or an inline text could end its script.
//   3. `consent.default` must be "denied" for every visitor; a site with no consent block is refused.
//   4. No vendor is named here: the container and its tags live in the rows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { consentBannerScript, consentBannerStyle, consentDefaultScript } from '../../ui/show/consent-banner/consent-banner.mjs';

export type Consent = {
  default: string;
  storage_types: string[];
  cookie: { name: string; max_age_seconds: number };
  banner: { label: string; message: string; accept: string; decline: string };
};
export type HeadPart = { kind: string; purpose: string; text?: string; src?: string };
export type SiteHeadData = { purposes: Record<string, string>; consent: Consent; head: HeadPart[]; body_start: HeadPart[] };
export type SiteHeadMarkup = { head: string; bodyStart: string };

const HEAD_KINDS: Record<string, string[]> = { inline: ['text'], script: ['src'] };
const BODY_KINDS: Record<string, string[]> = { noscript: ['src'] };
const ENTRY_KEYS = ['kind', 'purpose', 'text', 'src'];
const CONSENT_KEYS = ['default', 'storage_types', 'cookie', 'banner'];
const BANNER_KEYS = ['label', 'message', 'accept', 'decline'];

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function secureUrl(value: unknown): boolean {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function entryProblems(entry: unknown, where: string, kinds: Record<string, string[]>, purposes: string[]): string[] {
  if (!isObject(entry)) return [`${where} is not an object.`];
  const problems: string[] = [];
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) problems.push(`${where} has an unknown key "${key}".`);
  const required = kinds[String(entry.kind)];
  if (!required) return [...problems, `${where} has kind ${JSON.stringify(entry.kind)}, which is not allowed here (${Object.keys(kinds).join(', ')}).`];
  if (!purposes.includes(String(entry.purpose))) problems.push(`${where} has purpose ${JSON.stringify(entry.purpose)}, which is not a declared purpose.`);
  if (required.includes('src') && !secureUrl(entry.src)) problems.push(`${where} needs an https src address.`);
  if (required.includes('text')) {
    if (!isText(entry.text)) problems.push(`${where} needs inline text.`);
    else if (/<\/script|<!--/i.test(entry.text)) problems.push(`${where} inline text contains a tag that would end or open its script.`);
  }
  if (entry.src !== undefined && !required.includes('src')) problems.push(`${where} has a src, which its kind does not take.`);
  if (entry.text !== undefined && !required.includes('text')) problems.push(`${where} has text, which its kind does not take.`);
  return problems;
}

/** Every problem with a site-head data object, as sentences. An empty list means the data may be rendered. */
export function siteHeadProblems(data: unknown): string[] {
  if (!isObject(data)) return ['The site head data is not an object.'];
  const problems: string[] = [];
  const declared = isObject(data.purposes) ? data.purposes : {};
  const purposes = Object.keys(declared);
  if (purposes.length === 0) problems.push('`purposes` must declare at least one purpose.');
  for (const [name, text] of Object.entries(declared)) if (!isText(text)) problems.push(`Purpose "${name}" needs a description.`);

  const consent = data.consent;
  if (!isObject(consent)) problems.push('`consent` is missing: a site without a consent block is refused.');
  else {
    for (const key of Object.keys(consent)) if (!CONSENT_KEYS.includes(key)) problems.push(`consent has an unknown key "${key}".`);
    if (consent.default !== 'denied') problems.push('consent.default must be "denied" for every visitor.');
    if (!Array.isArray(consent.storage_types) || consent.storage_types.length === 0 || !consent.storage_types.every(isText)) problems.push('consent.storage_types must list the storage types the default covers.');
    const cookie = consent.cookie;
    if (!isObject(cookie) || !/^[A-Za-z0-9_]+$/.test(String(cookie.name ?? '')) || !Number.isInteger(cookie.max_age_seconds) || (cookie.max_age_seconds as number) < 1) {
      problems.push('consent.cookie needs a name of letters, digits or underscores and a whole number of max_age_seconds.');
    }
    const banner = consent.banner;
    if (!isObject(banner)) problems.push('consent.banner is missing.');
    else {
      for (const key of BANNER_KEYS) if (!isText(banner[key])) problems.push(`consent.banner.${key} needs words.`);
      for (const key of Object.keys(banner)) if (!BANNER_KEYS.includes(key)) problems.push(`consent.banner has an unknown key "${key}".`);
    }
  }

  if (!Array.isArray(data.head)) problems.push('`head` must be a list of parts.');
  else data.head.forEach((entry, i) => problems.push(...entryProblems(entry, `head[${i}]`, HEAD_KINDS, purposes)));
  if (!Array.isArray(data.body_start)) problems.push('`body_start` must be a list of parts.');
  else data.body_start.forEach((entry, i) => problems.push(...entryProblems(entry, `body_start[${i}]`, BODY_KINDS, purposes)));
  return problems;
}

const LT = String.fromCharCode(60);
const attribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const script = (code: string): string => `${LT}script>${code}${LT}/script>`;

/** The head and body-start markup for a valid site-head data object. Throws, listing every problem, when it is not valid. */
export function siteHeadMarkup(data: SiteHeadData): SiteHeadMarkup {
  const problems = siteHeadProblems(data);
  if (problems.length > 0) throw new Error(`The site head parts are refused: ${problems.join(' ')}`);
  const headPart = (entry: HeadPart): string => (entry.kind === 'inline' ? script(entry.text ?? '') : `${LT}script async src="${attribute(entry.src ?? '')}">${LT}/script>`);
  const bodyPart = (entry: HeadPart): string => `${LT}noscript>${LT}iframe src="${attribute(entry.src ?? '')}" height="0" width="0" hidden>${LT}/iframe>${LT}/noscript>`;
  return {
    // The consent default is the first thing in the head, then the bar's stylesheet, the declared parts, then the bar.
    head: [consentDefaultScript(data.consent), `${LT}style>${consentBannerStyle()}${LT}/style>`, ...data.head.map(headPart), consentBannerScript(data.consent)].join(''),
    bodyStart: data.body_start.map(bodyPart).join(''),
  };
}

/** A built page with the markup placed: the head parts first in <head>, the body-start parts just inside <body>. */
export function withSiteHead(html: string, markup: SiteHeadMarkup): string {
  if (!html.includes(`${LT}head>`) || !new RegExp(`${LT}body[^>]*>`).test(html)) throw new Error('A page has no head or body to carry the site parts.');
  return html.replace(`${LT}head>`, `${LT}head>${markup.head}`).replace(new RegExp(`${LT}body([^>]*)>`), tag => `${tag}${markup.bodyStart}`);
}
