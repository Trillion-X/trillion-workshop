// Private reactions to any address in one person's Trillion. The same { record, part? }
// anchor and palette as Space responses are used here; this store is the person's own
// record engine, so neither a Space audience nor another account can read these rows.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { VOTE, anchorFrom, foldReactions, reactionFrom, responseAnchorKey } from '../../keep-and-wake-ai-sessions-on-this-computer/src/responses.mjs';

const TYPE = 'private-response';
const idOf = anchor => `${TYPE}:${bytesToHex(blake3(new TextEncoder().encode(responseAnchorKey(anchor))))}`;

export function privateResponses(eeaf) {
  const read = raw => {
    const anchor = anchorFrom(raw);
    const kept = eeaf.read(idOf(anchor));
    return { anchor, ...foldReactions((kept?.rows ?? []).map(row => ({ ...row, relay: 'you', count: 1 })), 'you') };
  };
  const react = ({ record, part, symbol, glyph, on }) => {
    if (on !== undefined && typeof on !== 'boolean') throw new Error('Choose whether to add or remove this reaction.');
    const anchor = anchorFrom({ record, part });
    const reaction = reactionFrom({ symbol, glyph });
    if (reaction.symbol === VOTE) throw new Error('Votes belong to communities. Choose a reaction here.');
    const id = idOf(anchor);
    const kept = eeaf.read(id);
    const rows = kept?.rows ?? [];
    const had = rows.some(row => row.symbol === reaction.symbol);
    const give = on ?? !had;
    if (give !== had) {
      const changed = give
        ? [...rows, { symbol: reaction.symbol, glyph: reaction.glyph, at: new Date().toISOString() }]
        : rows.filter(row => row.symbol !== reaction.symbol);
      eeaf.write([{ id, type: TYPE, value: { anchor, rows: changed } }], { actor: { by: 'person' } });
    }
    return read(anchor);
  };
  return { read, react };
}
