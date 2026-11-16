// tools/see-a-pursuit-through-the-lens/do-work/see-a-pursuit-through-the-lens.mjs
//
// tool:see-a-pursuit-through-the-lens, run as a function (tools/records-door do-work/run-an-export.mjs): how an AI
// should look at what a person is pursuing, from that person's own lens. The caller hands the lens in (`lens`: the
// lens rows its AI read from the person's lists, and the opening, parts and closing it read around them); this keeps
// nothing and reads nothing. The answer is what src/pursuit-lens.mjs makes of it, unchanged: the paragraph every AI
// reads when it connects, and the setup with every part and each row whole.
//
//   seeAPursuitThroughTheLens(input) -> { paragraph?, setup?, joining_interview_file }
//   input: { lens: { opening, parts, closing, rows }, answer?: 'paragraph' | 'setup' | 'both' (default both) }
import data from '../read-data/see-a-pursuit-through-the-lens.json' with { type: 'json' };
import { JOINING_INTERVIEW_FILE, lensForSetup, lensParagraph } from '../src/pursuit-lens.mjs';

const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function seeAPursuitThroughTheLens(input = {}) {
  const { answer = 'both', lens } = input ?? {};
  if (!['paragraph', 'setup', 'both'].includes(answer)) refuse('bad_answer', data.words.bad_answer);
  if (!object(lens) || !Array.isArray(lens.parts) || !Array.isArray(lens.rows)) refuse('bad_lens', data.words.bad_lens);
  return {
    ...(answer !== 'setup' ? { paragraph: lensParagraph(lens) } : {}),
    ...(answer !== 'paragraph' ? { setup: lensForSetup(lens) } : {}),
    joining_interview_file: JOINING_INTERVIEW_FILE,
  };
}
