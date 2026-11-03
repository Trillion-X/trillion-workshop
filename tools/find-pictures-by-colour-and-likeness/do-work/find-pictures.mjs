// tools/find-pictures-by-colour-and-likeness/do-work/find-pictures.mjs
//
// tool:find-pictures-by-colour-and-likeness. The row's request handed to the moved colour search
// (src/colour-search.mjs): rows are the pictures' facts ({ id, palette?, embedding? }) and exactly one of
//   question  words with typed #rrggbb colours and colour words: a picture matching any colour asked (coloursIn)
//   colour    one #rrggbb, matched under the typed ceiling (matchColour)
//   like      a row id: pictures like it, by embedding cosine, falling back to palette distance (similarTo)
// Ids come back; nothing is read or kept.
import { coloursIn, matchColour, similarTo } from '../src/colour-search.mjs';

export function findPictures({ rows, question, colour, like } = {}) {
  if (!Array.isArray(rows)) throw new Error('Give rows: the pictures as [{ id, palette: ["#rrggbb", ...], embedding?: [numbers] }].');
  const asked = [question, colour, like].filter(value => value !== undefined);
  if (asked.length !== 1) throw new Error('Ask one thing: question (words naming colours), colour (one #rrggbb) or like (the id of a picture to find others like).');
  if (like !== undefined) {
    if (!rows.some(row => row.id === like)) throw new Error(`No row has the id ${like}; like names one of the rows given.`);
    return similarTo(rows, like);
  }
  if (colour !== undefined) {
    if (!/^#?[0-9a-f]{6}$/i.test(String(colour).trim())) throw new Error('colour is one #rrggbb, such as #3366cc.');
    return { ids: matchColour(rows, colour), by: 'colour', asked: [{ hex: String(colour).toLowerCase() }] };
  }
  const colours = coloursIn(question);
  if (!colours.length) return { ids: [], by: 'colour', asked: [] };
  const ids = new Set(colours.flatMap(({ hex, ceiling, top }) => matchColour(rows, hex, { ceiling, top })));
  return { ids: rows.map(row => row.id).filter(id => ids.has(id)), by: 'colour', asked: colours };
}
