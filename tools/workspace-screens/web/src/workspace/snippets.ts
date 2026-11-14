// src/workspace/snippets.ts
//
// PURPOSE
//   The person's snippets (words they send again and again, src/snippets.mjs) for the shared message box: the list the
//   box offers in its Snippets menu, and the one call that fills a snippet's blanks and counts the use. Both go to the
//   person's own store through the posts road (src/work-posts.mjs `snippet/<verb>`), so the box and their AIs see the same snippets.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The list is read from the store when the box is drawn and again after a snippet is used; nothing is cached across
//      people or pages.
//   2. A snippet's blanks are filled with nothing here: a blank stays as written so the person sees and fills it, and a
//      read that fails offers no menu rather than an empty one that looks like "no snippets".
//   3. Words are DATA (snippets.json `words`, the menu's label is the composer's own words).

import React from 'react';
import type { ComposerSnippets } from '../../parts/ui/show/composer';
import { postJson } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';

const ROAD = '/work/api/posts/snippet';
type Row = { snippet_id: string; title: string; text: string };

/** The snippets menu for a message box (its first row saves the words written), or undefined when the store could not be read. */
export function useSnippets(): ComposerSnippets | undefined {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const read = React.useCallback(() => postJson<{ snippets: Row[] }>(`${ROAD}/list`, {}).then(answer => setRows(answer.snippets), () => setRows(null)), []);
  React.useEffect(() => { void read(); }, [read]);
  const use = React.useCallback(async (id: string) => {
    const filled = await postJson<{ text: string }>(`${ROAD}/use`, { snippet_id: id });
    void read();
    return filled.text;
  }, [read]);
  // Keeps the words in the box as a snippet titled by their first line (the person can retitle it by asking their AI, save_snippet).
  const save = React.useCallback(async (words: string) => {
    await postJson(`${ROAD}/save`, { title: words.split('\n').find(line => line.trim())?.trim().slice(0, 60) ?? words.slice(0, 60), text: words });
    notify('Saved as a snippet.', { kind: 'done' });
    await read();
  }, [read]);
  return React.useMemo(() => (rows ? { rows: rows.map(row => ({ id: row.snippet_id, title: row.title, detail: row.text.replace(/\s+/g, ' ').slice(0, 60) })), use, save, search: { placeholder: 'Find a snippet' } } : undefined), [rows, use, save]);
}
