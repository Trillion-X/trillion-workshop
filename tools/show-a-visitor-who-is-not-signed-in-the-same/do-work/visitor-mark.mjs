// tools/show-a-visitor-who-is-not-signed-in-the-same: the mark that keeps a visitor on the same price (`nm_visitor`). The
// mark is read from a request's cookies, or made new. Pure: no store and no clock. Ported from the older repository's
// src/visitor-mark.mjs (commit b6ae0ebf81). The cookies that set the mark and the offers a visitor is shown are in
// the offers owner (held here until its price rules come back).

export const VISITOR_COOKIE = 'nm_visitor';
const cookieValues = (request, name) => (request.headers.get('cookie') ?? '').split(/;\s*/).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));

/** The visitor's mark, or null. A malformed value is skipped for a well-formed one. */
export const visitorOf = request => cookieValues(request, VISITOR_COOKIE).map(value => value.match(/^[0-9a-f]{32}$/)?.[0]).find(Boolean) ?? null;

/** A new mark: 16 random bytes as 32 lowercase hex characters. */
export const newVisitor = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
