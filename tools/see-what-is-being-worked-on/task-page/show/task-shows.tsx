// The shows a task produced, drawn inline in its opened row, one after another in the order they were made. Each one is
// drawn by show-any-file-as-itself (ShowRef), which chooses the way it is shown, so nothing here names a kind of thing.
// Opened only: a closed row mounts none of them, so nothing loads until the person opens the task.
import React from 'react';
import { ShowRef } from 'trillion-workshop/tools/show-any-file-as-itself/show/ShowRef';
import type { Show } from '../read-data/task-rows';

export function OpenedShows({ shows }: { shows: Show[] }) {
  if (shows.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-5 pb-3 pl-8 pr-6">
      {shows.map(show => (
        <li key={show.ref}>
          <ShowRef source={show.ref} label={show.label} />
        </li>
      ))}
    </ul>
  );
}
