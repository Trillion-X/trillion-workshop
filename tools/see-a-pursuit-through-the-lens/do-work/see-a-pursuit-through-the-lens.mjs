// tools/see-a-pursuit-through-the-lens/do-work/see-a-pursuit-through-the-lens.mjs
//
// tool:see-a-pursuit-through-the-lens, run as a function (tools/records-door do-work/run-an-export.mjs): how an AI
// should look at what a person is pursuing, from that person's own lens. The lens is handed in (`lens`), or read from
// the person's lists through their records door: its rows are the rows of one list, and what it says around them
// (opening, parts, closing) is one row of another (read-data/see-a-pursuit-through-the-lens.json names both). The
// answer is what src/pursuit-lens.mjs makes of it, unchanged: the paragraph every AI reads when it connects, and the
// setup with every part and each row whole.
//
//   seeAPursuitThroughTheLens(input, { door }) -> { paragraph?, setup?, joining_interview_file }
//   input: { answer?: 'paragraph' | 'setup' | 'both' (default both), lens?: { opening, parts, closing, rows } }
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import data from '../read-data/see-a-pursuit-through-the-lens.json' with { type: 'json' };
import { JOINING_INTERVIEW_FILE, lensForSetup, lensParagraph } from '../src/pursuit-lens.mjs';

const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The person's lens from their lists: the rows of its list, and the row that holds its opening, parts and closing. */
export async function lensFromLists(door) {
  const lists = listsOverDoor(door);
  const { rows: where, about_row: about, words } = data;
  if (!await lists.has(where.list)) refuse('no_lens', fill(words.no_lens, where));
  const { rows } = await lists.read(where.list);
  if (!rows.length) refuse('no_lens', fill(words.no_lens, where));
  const around = await door.read(`record:${about.row_type}`, `record:${about.row_type}:${about.row}`);
  if (!object(around)) refuse('no_about', fill(words.no_about, about));
  return { ...around, rows: rows.map(row => ({ id: row.id, ...row.values })) };
}

export async function seeAPursuitThroughTheLens(input = {}, { door } = {}) {
  const { answer = 'both', lens: given } = input ?? {};
  if (!['paragraph', 'setup', 'both'].includes(answer)) refuse('bad_answer', data.words.bad_answer);
  const lens = given ?? await lensFromLists(door);
  if (!object(lens) || !Array.isArray(lens.parts) || !Array.isArray(lens.rows)) refuse('bad_lens', data.words.bad_lens);
  return {
    ...(answer !== 'setup' ? { paragraph: lensParagraph(lens) } : {}),
    ...(answer !== 'paragraph' ? { setup: lensForSetup(lens) } : {}),
    joining_interview_file: JOINING_INTERVIEW_FILE,
  };
}
