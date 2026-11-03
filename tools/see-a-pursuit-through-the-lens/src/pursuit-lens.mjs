// How an AI sees what a person is pursuing, as DATA in ../methods/pursuit-lens.json: the places to look, the parts
// to read what it finds by (what goes on inside the person, the game around them, the one move that matters), and
// rows of what to look for and what to do, each written from a file and section of the founder's own frameworks.
// Where a row came from (`source`) stays in the repository: the build strips it and nothing here sends it out.
import lens from '../methods/pursuit-lens.json' with { type: 'json' };

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
