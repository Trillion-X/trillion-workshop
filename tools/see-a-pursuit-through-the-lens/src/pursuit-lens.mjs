// How an AI sees what a person is pursuing, as DATA: the places to look, the parts to read what it finds by (what goes
// on inside the person, the game around them, the one move that matters), and rows of what to look for and what to do.
// The lens is the person's own rows, handed in by whoever calls this: useLens(lens) once (Trillion's own in-account
// run hands in the rows it keeps), or each function's `data` (the Workshop row reads them from the person's lists
// through their records door, do-work/see-a-pursuit-through-the-lens.mjs). Where a row came from (`source`) is never
// sent out by anything here.
let lens = null;

/** Hand in the lens ({ opening, parts, closing, rows }) the functions read when they are given none. */
export function useLens(data) {
  lens = data;
  return lens;
}

// Where a joining interview's answers are kept in the person's own files, so any of their AIs can continue it.
export const JOINING_INTERVIEW_FILE = '/Pursuits/joining interview.json';

// The paragraph every AI reads when it connects: the opening, then each part in one sentence, then the closing,
// which says start_setup returns every row whole.
export function lensParagraph(data = lens) {
  return [data.opening, ...data.parts.map(part => `${part.name}: ${part.about}`), data.closing].join(' ');
}

// What start_setup returns: every part with each row whole, so the AI knows what to look for and what to do.
export function lensForSetup(data = lens) {
  // The rows a joining interview walks are the ones the lens DATA marks `joining_interview`.
  const joining = data.rows.filter(row => row.joining_interview === true).map(({ look_for, ask_or_do }) => ({ look_for, ask_or_do }));
  return {
    how: data.opening,
    joining_interview: {
      when: 'When someone joins with no pursuits, or their pursuits look thin or old, read their reachable history first, then ask the unanswered questions one at a time.',
      kept_in: JOINING_INTERVIEW_FILE,
      keep: `Before asking anything, read ${JOINING_INTERVIEW_FILE} with read_file: a question already answered there is never asked again, by you or any other AI, so an interview another AI started continues where it stopped. After each answer, save the whole file again with write_file (media_type application/json) as {"answers": [{"question", "answer" (their words), "answered_at", "evidence": [{"where", "date", "quote_or_fact"}], "matches_their_files" (true, false, or null when nothing was found)}]}. Where matches_their_files is false is where to look next. When the pursuit is clear, record it with record_pursuits, quoting that evidence.`,
      rows: joining,
    },
    parts: data.parts.map(part => ({ name: part.name, about: part.about, rows: data.rows.filter(row => row.part === part.id).map(({ look_for, ask_or_do }) => ({ look_for, ask_or_do })) })),
    then: data.closing,
  };
}

export { lens };
