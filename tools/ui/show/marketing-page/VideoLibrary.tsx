// tools/ui/show/marketing-page/VideoLibrary.tsx
//
// PURPOSE
//   The clickable video library as a page row names it: `ui/show/marketing-page/VideoLibrary.tsx#VideoLibrary`, with props
//   that are plain JSON values only, so the site tool can place it from a row. A picker of the library names (the first is
//   chosen), under it the chosen library's count of entries and a large preview of the chosen entry (picture, title, length),
//   then the entry list; pressing an entry makes it the preview. It is Library with its own small state, so a page needs no
//   host to make it work.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Props are plain JSON: `intro`, `title`, `count_words` ({count} is filled in) and `libraries`
//      ([{name, entries:[{id, title, duration, image, image_large}]}]). Nothing here takes a function or a React node.
//   2. The state is two choices only, the library and the entry; nothing is fetched and no window is read. Drawn first (and on
//      the server) it shows the first library and its first entry.
//   3. An entry shows only in its own library; each list row says "<library> · <duration>".
//   4. Everything drawn is Library's (shared Button, MediaFrame, Text and the screen look's classes).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useState } from 'react';
import { View as Library, type LibraryEntry, type LibraryTab } from './Library.tsx';

export type VideoLibraryProps = {
  intro?: string;
  title?: string;
  count_words?: string;
  libraries: readonly { name: string; entries: readonly { id: string; title: string; duration?: string; image?: string; image_large?: string }[] }[];
};

export function VideoLibrary({ intro, title, count_words = '{count}', libraries }: VideoLibraryProps) {
  const [tab, setTab] = useState<string | undefined>(undefined);
  const [entry, setEntry] = useState<string | undefined>(undefined);
  const tabs: LibraryTab[] = libraries.map(library => ({ id: library.name, label: library.name }));
  const entries: LibraryEntry[] = libraries.flatMap(library => library.entries.map(item => ({
    id: item.id,
    tab: library.name,
    title: item.title,
    meta: item.duration ? `${library.name} · ${item.duration}` : library.name,
    duration: item.duration,
    still: item.image,
    large: item.image_large ?? item.image,
  })));
  return (
    <Library
      intro={intro}
      tabs={tabs}
      entries={entries}
      selectedTab={tab}
      selectedId={entry}
      browserTitle={title}
      countLabel={count_words}
      onSelectTab={id => { setTab(id); setEntry(undefined); }}
      onSelectEntry={setEntry}
    />
  );
}
