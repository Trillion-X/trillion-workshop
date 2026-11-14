// src/old-tab-repaint.mjs
//
// PURPOSE
//   Says whether a request for the workspace page is an old tab repainting itself: a tab opened before the workspace
//   whose script fetches its own address and copies the answer's #root into the page. That answer carries a reload
//   (src/worker.mjs workspacePage, reload_on_insert) so the old tab loads the workspace instead of painting nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A page load is never marked, however it reaches the Worker. A page load passed on by a service worker arrives
//      without its `document` destination, but it still asks for a browser page (`application/xhtml+xml` in its
//      accept) or says it navigates; marking it reloads the page forever and paints a white screen.
//   2. The old tab's fetch is marked: no destination, not a navigation, asking for `text/html` alone.

export const oldTabRepaint = request => request.headers.get('sec-fetch-dest') === 'empty'
  && request.headers.get('sec-fetch-mode') !== 'navigate'
  && !(request.headers.get('accept') ?? '').includes('application/xhtml+xml');
