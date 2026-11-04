// The mark that keeps a visitor on the same price (`nm_visitor`): read from a request's cookies, or made new. The offers a
// visitor is shown and the cookies that set the mark are src/visitor-offers.mjs; a signed-in browser's mark goes to the
// reads that quote prices (src/payment.mjs priceArmsFor), so the price it saw before signing in is the price it keeps.
import { bytesToHex } from '@noble/hashes/utils.js';

export const VISITOR_COOKIE = 'nm_visitor';
const cookieValues = (request, name) => (request.headers.get('cookie') ?? '').split(/;\s*/).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
/** The visitor's mark, or null. */
export const visitorOf = request => cookieValues(request, VISITOR_COOKIE).map(value => value.match(/^[0-9a-f]{32}$/)?.[0]).find(Boolean) ?? null;
export const newVisitor = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
