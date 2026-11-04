// src/work-title.mjs
//
// Purpose
//   The one owner of the short plain title any piece of work is shown by: the words a card, a notification, a widget
//   row, the work map and every list of work read, while the work's full job opens only behind it. Work handed to an
//   AI keeps its title as `said` (src/agents.mjs, src/live-work.mjs): the asker's own words when given, else the title
//   this owner derives once from the job's own words when the work is handed off.
//
// Non-negotiable invariants
//   1. Deterministic and free: the title is cut from the job's own words, never asked of a model.
//   2. Plain words about the task: markdown marks, links, addresses, file paths, ids and long codes are taken out; a
//      sentence naming a program word (snake_case, like a tool name) was written for the AI and is passed over; and a
//      heading is used only when it says something about the task (a short label like "Handoff summary" is passed over
//      for the first sentence under it).
//   3. Short: at most TITLE_MAX characters, cut at a word boundary with "…", never mid-word.
//   4. Never empty: a job with no plain words left gets FALLBACK, so no surface draws a wordless row.
//   5. Nothing here names a job, a screen, an AI or a person.
//

/** The longest derived title, in characters: one line on a phone card. */
export const TITLE_MAX = 80;
/** A heading shorter than this many words is a label, not a title. */
const HEADING_MIN_WORDS = 3;
/** The title of work whose job holds no plain words at all. */
export const FALLBACK = 'Sent to your AIs';

const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const ADDRESS = /\b(?:https?|ftp|file|mailto):\S+/gi;
const PATH = /(?:^|\s)(?:~|\.{1,2})?\/[^\s,;:)]*\/[^\s,;)]*/g;
// An id or code: a short prefix joined by _ or : to a long run holding a digit (h_4677…, 1f:ab12…), or a long hex run.
const ID = /\b[a-z0-9]{1,6}[_:](?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{8,}\b|\b[0-9a-f]*\d[0-9a-f]*\b(?<=\b\w{8,})/gi;
// A word written for a program, not a person (take_work, handoff_id): a sentence holding one was written for the AI.
const CODE = /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/;
const MARKS = /(\*\*|__|\*|`+|~~)/g;
const LEAD = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;
// A label before a colon that only names the kind of text ("Handoff:", "Task:"), not the task itself.
const LABEL = /^[A-Za-z][A-Za-z ]{0,24}:\s+(?=\S)/;

const clean = line => line
  .replace(LINK, '$1').replace(ADDRESS, ' ').replace(PATH, ' ').replace(ID, ' ').replace(MARKS, '')
  .replace(LEAD, '').replace(/\(\s*[,;.]*\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();

const plain = text => /[\p{L}]/u.test(text);

/** A run of words as its sentences, each without its final full stop. */
const sentences = text => text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u).map(one => one.replace(/[.:;,]+$/, '').trim());

/** At most TITLE_MAX characters, cut at a word boundary. */
const fit = text => {
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
};

/** A short plain title from a job's own words (invariants 1-4). */
export function workTitle(job) {
  for (const raw of String(job ?? '').split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s/.test(raw);
    const line = clean(raw).replace(LABEL, '');
    if (!plain(line) || (heading && line.split(' ').length < HEADING_MIN_WORDS)) continue;
    for (const sentence of sentences(line)) {
      if (CODE.test(sentence) || !plain(sentence)) continue;
      return fit(sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1));
    }
  }
  return FALLBACK;
}

/** The title a piece of work is shown by: its kept `said`, else the one derived from its job. */
export const titleOf = work => (typeof work?.said === 'string' && work.said.trim() ? work.said.trim() : workTitle(work?.job));
