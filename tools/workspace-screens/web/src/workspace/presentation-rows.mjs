// The rows the page plays (feel, delight) and the words every tour says (tour-words) are the shipped DATA
// (src/presentation-bootstrap.mjs), the same the presentation owner answers when nothing newer is published: the engine
// has no presentation route (macos/release.json route_owner_gate.retired names /work/api/tours/*), so nothing here asks
// the store, and a changed row ships with the page. No account copy, timer or publication owner of its own.
import { presentationBootstrap } from '../presentation-bootstrap.mjs';
import { checkedTourWordContent } from '../tour-word-content.mjs';

export async function presentationRows(part){
 if(!Object.hasOwn(presentationBootstrap,part))throw new TypeError('Choose feel, delight or tour-words rows.');
 const rows=structuredClone(await presentationBootstrap[part]());
 if(part==='tour-words')return checkedTourWordContent(rows);
 if(!Array.isArray(rows.moments))throw new TypeError('The current presentation rows could not be read.');
 return rows;
}
