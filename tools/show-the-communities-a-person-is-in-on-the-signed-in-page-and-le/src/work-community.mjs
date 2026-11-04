// src/work-community.mjs
//
// PURPOSE
//   The Community screens of the signed-in workspace (src/workspace/community-screen.tsx) read the person's
//   communities through this page's own session: the same person-side routes an AI uses (src/person-community.mjs),
//   passed to the person's own store unchanged. Their actions post to /community/... directly, the route the AI and
//   the public page share (communityRoute in src/worker.mjs).
//
//   GET  /work/api/community          the communities this person can see or is in
//   GET  /work/api/community/<id>     one community as this person may see it, with where they stand in it
//   GET  /work/api/community/events?from=&to=  every event in every space this person is in, for the calendar
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here decides anything about a community: every answer is the person store's own, word for word.
//   2. Reads only; writes keep the one /community road and its origin check.

const json = (value, status = 200) => Response.json(value, { status });

export const isWorkCommunityPath = path => path === '/work/api/community' || path.startsWith('/work/api/community/');

export async function handleWorkCommunity(request, { person, origin, url }) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  const rest = url.pathname.slice('/work/api/community'.length);
  if (rest && (rest === '/' || rest.slice(1).includes('/'))) return json({ error: 'Not found' }, 404);
  return person.fetch(new Request(`https://person/community${rest}${rest === '/events' ? url.search : ''}`, { headers: { 'x-trillion-origin': origin } }));
}
