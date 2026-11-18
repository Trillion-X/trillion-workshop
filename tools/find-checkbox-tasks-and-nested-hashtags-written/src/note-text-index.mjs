// src/note-text-index.mjs
//
// PURPOSE
//   The note-text parser: checkbox tasks and nested #tags written inside note text, read from the text handed in and
//   handed back as values. It keeps nothing and reaches no store. The person's store keeps the tasks and tags it finds,
//   through the workflow recipe workflow:keep-note-tasks-and-tags (tools/workflows/recipes), which calls this parser on
//   the note text it is given (rule a-tool-is-only-what-the-store-cannot-do: computing what a store cannot hold).
//
//   Tasks: a paragraph that starts with a checkbox, `[ ]` open or `[x]` done, optionally behind a list marker.
//   Tags (Bear style): `#tag`, nested `#work/project` (the note also carries `work`), and `#multi word tag#`. Matching is
//   case-insensitive; `display` is the spelling first written in the note. A heading (`# Title`), a number alone
//   (`#12`) and anything inside a fenced code block or a code span is not a tag.
//
//   Limits and patterns are DATA (tools/shared-code/src/note-text-index.json); nothing here names an app, a note kind or
//   a space. Content identity is BLAKE3 (identityOf), so a store can skip a note whose text it already holds.
//
// Values in, values out:
//   parseNoteText(text)            -> { tasks: [{ position, line, text, done }], tags: [{ tag, display, explicit }] }
//   identityOf(text)               -> the BLAKE3 identity (32 hex characters) of the text given
//   noteTextIdentity(kind, space_id, text) -> the identity the recipe keeps for a note with no identity of its own
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import settings from '../../shared-code/src/note-text-index.json' with { type: 'json' };

const TASK_LINE = new RegExp(settings.task_line);
const FENCE = new RegExp(settings.fence);
const sep = settings.tag_separator;
const word = settings.tag_chars;
const WRITTEN = `(?:${word}(?:${sep.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}${word}){0,${settings.tag_max_depth - 1}})`;
const CLOSE = settings.tag_multiword_close;
const TAG = new RegExp(`${settings.tag_start_boundary}#(?:([^\\s#](?:[^#\\n]{0,${settings.tag_max_chars}}[^\\s#])?)${CLOSE}(?![\\p{L}\\p{N}])|(${WRITTEN}))`, 'gu');
const CODE_SPAN = /`[^`\n]*`/g;
const oneLine = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value);
export const identityOf = text => bytesToHex(blake3(utf8ToBytes(text)).slice(0, 16));
const lowered = value => value.toLocaleLowerCase();

/** The tags written on one line (outside code spans), as { display } in the order written. */
function tagsOfLine(line) {
  const found = [];
  for (const match of line.replace(CODE_SPAN, ' ').matchAll(TAG)) {
    const multi = match[1] !== undefined, written = (multi ? match[1] : match[2]).trim();
    if (!written || (multi && !/\s/.test(written)) || /^\d+$/.test(written) || written.length > settings.tag_max_chars) continue;
    found.push(written);
  }
  return found;
}

/** Every task and tag in a note's text. A tag lists itself (explicit) and each parent of its path (not explicit). */
export function parseNoteText(text) {
  const tasks = [], tags = new Map();
  let fenced = false;
  const keep = (display, explicit) => {
    const key = lowered(display);
    const held = tags.get(key);
    if (!held) tags.set(key, { tag: key, display, explicit });
    else if (explicit && !held.explicit) tags.set(key, { tag: key, display, explicit: true });
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const task = TASK_LINE.exec(line);
    if (task) tasks.push({ position: tasks.length, line: line.trimEnd(), text: task[2].trim(), done: task[1] !== ' ' });
    for (const written of tagsOfLine(task ? task[2] : line)) {
      keep(written, true);
      const path = written.split(sep);
      for (let depth = path.length - 1; depth >= 1; depth--) keep(path.slice(0, depth).join(sep), false);
    }
  }
  return { tasks, tags: [...tags.values()] };
}


/** The identity a note with no identity of its own is kept under: kind, space and text, in BLAKE3. */
export const noteTextIdentity = (kind, spaceId, text) => identityOf(`${kind}\n${spaceId}\n${text}`);
