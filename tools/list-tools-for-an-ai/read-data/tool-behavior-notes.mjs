// src/tool-behavior-notes.mjs
//
// THE WORDS AN AI READS ABOUT A TOOL ARE SAID FROM THE SAME HINTS ITS APP OBEYS.
//
// Purpose: a tool states four hints (read-only, destructive, idempotent, open-world) so an AI app decides whether to ask the
// person first. The description an AI reads should say the same thing in words, or an AI reading only the description
// acts differently from an app reading only the hints. This adds, after a tool's own description, one sentence per matching
// row of ./tool-behavior-notes.json, and never repeats what the description already says.
//
// Non-negotiable invariants:
//   1. This file names no tool and no hint value: the rows are DATA, tried in order, each needing every hint it names.
//   2. A description that already says it (any `unless` phrase, case-insensitive) is left as written.
//   3. A tool with no hints is returned as it is; behavior is described, never guessed.
//   4. Pure: the same tool and rows give the same description.
//
// Key concept: `withBehaviorNotes(tool, rows?)` -> the tool with its description extended.
import notes from './tool-behavior-notes.json' with { type: 'json' };

const matches = (when, hints) => Object.entries(when).every(([hint, value]) => hints?.[hint] === value);

/** `tool` with the sentences its hints call for added to its description. */
export function withBehaviorNotes(tool, rules = notes) {
  if (typeof tool?.description !== 'string' || !tool.annotations) return tool;
  const said = tool.description.toLowerCase();
  const added = rules.rows.filter(row => matches(row.when, tool.annotations) && !row.unless.some(phrase => said.includes(phrase)))
    .map(row => row.say);
  return added.length ? { ...tool, description: `${tool.description.trimEnd()} ${added.join(' ')}` } : tool;
}
