// tools/serve-a-sites-pages-from-its-rows/do-work/address-cookies.ts
//
// PURPOSE
//   Cookies a site keeps from the address a visitor arrives at: a link such as https://example.com/?ref=AB12CD carries a value
//   (a referral code) that a later action needs (a checkout's { "$": "cookie" } source), so any page the visitor opens with it
//   sets it as a cookie, on the site's own pages and on pages another program answers for the site alike. Each rule is a
//   settings row (serve.ts settings `address_cookies`), never a page script: it works with no JavaScript, and the value is
//   checked before it is kept.
//
//   A rule: { query, cookie, pattern, upper_case?, max_age_days, domain?, http_only? }
//     query        the address's query name the value comes from, such as "ref"
//     cookie       the cookie it is kept as
//     pattern      the whole value it must be (a regular expression, anchored here), checked after upper_case; any other
//                  value is not kept, and the cookie already held is left as it is
//     upper_case   true: the value is kept in capitals (a code typed in either case is the same code)
//     max_age_days how long it is kept
//     domain       (optional) the cookie's Domain when the request is for that host or one under it, so it reaches the
//                  site's other hosts too (app.example.com); for any other host it is that host's alone
//     http_only    (optional, true when left out) false only when a page's own script must read it
//
// NON-NEGOTIABLE INVARIANTS
//   1. A value is kept only when it is the whole of `pattern`, so no address can put any other bytes in a cookie header.
//   2. Every cookie is Path=/, SameSite=Lax and Secure.
//   3. Only GET and HEAD keep a cookie: an address is followed by GET; a POST's cookies are its action row's.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export interface AddressCookie {
  query: string;
  cookie: string;
  pattern: string;
  upper_case?: boolean;
  max_age_days: number;
  domain?: string;
  http_only?: boolean;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const WORDS = 'address_cookies lists { query, cookie, pattern, upper_case?, max_age_days, domain?, http_only? }: names of letters, digits, _ and -, a regular expression, a whole number of days of 1 or more, a lower-case host name.';

/** Checks the settings' address_cookies; a wrong one throws naming what each field should be. */
export function addressCookiesOf(value: unknown): AddressCookie[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(WORDS);
  for (const rule of value as Partial<AddressCookie>[]) {
    if (!rule || typeof rule !== 'object' || typeof rule.query !== 'string' || !NAME.test(rule.query) || typeof rule.cookie !== 'string' || !NAME.test(rule.cookie)
      || typeof rule.pattern !== 'string' || !Number.isInteger(rule.max_age_days) || rule.max_age_days! < 1
      || (rule.upper_case !== undefined && typeof rule.upper_case !== 'boolean') || (rule.http_only !== undefined && typeof rule.http_only !== 'boolean')
      || (rule.domain !== undefined && (typeof rule.domain !== 'string' || !DOMAIN.test(rule.domain)))) throw new Error(WORDS);
    try { new RegExp(`^(?:${rule.pattern})$`); } catch { throw new Error(`address_cookies: ${rule.cookie}'s pattern is not a regular expression.`); }
  }
  return value as AddressCookie[];
}

/** The Set-Cookie headers one request's address gives: one for each rule whose query value is the whole of its pattern. */
export function cookiesFromAddress(rules: AddressCookie[], method: string, url: string, host: string): string[] {
  if (rules.length === 0 || (method !== 'GET' && method !== 'HEAD')) return [];
  const query = new URL(url, 'http://site.invalid').searchParams;
  const kept: string[] = [];
  for (const rule of rules) {
    const given = query.get(rule.query);
    if (given === null) continue;
    const value = rule.upper_case ? given.trim().toUpperCase() : given.trim();
    if (!new RegExp(`^(?:${rule.pattern})$`).test(value) || !/^[A-Za-z0-9._~-]+$/.test(value)) continue;
    const onDomain = rule.domain !== undefined && (host === rule.domain || host.endsWith(`.${rule.domain}`));
    kept.push(`${rule.cookie}=${value}; Max-Age=${rule.max_age_days * 86400}; Path=/${onDomain ? `; Domain=${rule.domain}` : ''}; SameSite=Lax; Secure${rule.http_only === false ? '' : '; HttpOnly'}`);
  }
  return kept;
}

/** Headers with the address's cookies added beside any Set-Cookie they already carry. */
export function withCookies<T extends Record<string, string | string[] | number | undefined>>(headers: T, cookies: string[]): T {
  if (cookies.length === 0) return headers;
  const had = headers['set-cookie'];
  const before = had === undefined ? [] : Array.isArray(had) ? had : [String(had)];
  return { ...headers, 'set-cookie': [...before, ...cookies] };
}
