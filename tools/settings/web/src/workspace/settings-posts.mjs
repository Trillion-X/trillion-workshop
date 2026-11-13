// src/workspace/settings-posts.mjs
//
// PURPOSE
//   The What's new page's posts (settings-pages.tsx, F-1000) as the page draws them, from what the build published at
//   /workspace/whats-new.json (src/whats-new-rows.mjs). Pure; the limit is DATA (settings-pages.json whats_new.most_rows).
//
// NON-NEGOTIABLE INVARIANTS
//   1. An answer that is not { rows: [...] } is no answer (null), never an empty list: the page says it failed.
//   2. A row without an id, a title and a date is left out; rows keep the order the build gave (newest first); at most
//      `most_rows` are kept, and each row's points are cut to strings.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import pages from './settings-pages.json' with { type: 'json' };

/** The posts as drawn, or null when the answer is not a list of rows. */
export function postsOf(answer) {
  const rows = answer?.rows;
  if (!Array.isArray(rows)) return null;
  return rows
    .filter(row => row && typeof row.id === 'string' && row.id && typeof row.title === 'string' && row.title && typeof row.date === 'string')
    .slice(0, pages.whats_new.most_rows)
    .map(row => ({
      id: row.id, date: row.date, title: row.title, summary: typeof row.summary === 'string' ? row.summary : '',
      points: Array.isArray(row.points) ? row.points.filter(point => typeof point === 'string' && point) : [],
      picture: row.picture && typeof row.picture.src === 'string' && row.picture.src ? { src: row.picture.src, alt: typeof row.picture.alt === 'string' ? row.picture.alt : '' } : null,
      open: typeof row.open === 'string' ? row.open : `/?tour=${encodeURIComponent(row.tour ?? row.id)}`,
    }));
}

/** A post's date in the person's own words for a day (the build writes YYYY-MM-DD). */
export function dayOf(date) {
  const day = new Date(`${date}T12:00:00`);
  return Number.isNaN(day.getTime()) ? date : day.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
