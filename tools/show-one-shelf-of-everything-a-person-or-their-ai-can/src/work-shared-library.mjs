// src/work-shared-library.mjs
//
// PURPOSE
//   The shared libraries (src/design-library.mjs) for the signed-in workspace: the Marketplace screen reads every
//   account's studied entries through this page's own session, over the same person-store routes an AI's
//   search_shared_library and remove_from_shared_library reach.
//
//   GET    /work/api/shared-library?dataset=&q=&offset=&limit=&<field>=<value>
//          -> { rows: [{ id, dataset, title, fields, image_url | null, image_type?, added_by, yours, added_at }], total,
//               offset, limit, datasets: [{ id, label, description, title_field, fields: [{ id, label, type, choices? }] }] }
//   DELETE /work/api/shared-library/<id>   removes one of this person's own entries -> { removed: true, id }
//
// NON-NEGOTIABLE INVARIANTS
//   1. One road: the answer is the person store's own, passed on with its status and words; nothing is reshaped here.
//   2. A removal is sent only from this app's own pages (the request's origin is this service), never from another site.
const json = (value, status = 200) => Response.json(value, { status });

export const isWorkSharedLibraryPath = path => path === '/work/api/shared-library' || path.startsWith('/work/api/shared-library/');

export async function handleWorkSharedLibrary(request, { person, origin, url }) {
  if (request.method === 'GET' && url.pathname === '/work/api/shared-library') return person.fetch(new Request(`https://person/shared-library${url.search}`));
  const removal = url.pathname.match(/^\/work\/api\/shared-library\/([^/]+)$/);
  if (request.method === 'DELETE' && removal) {
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    return person.fetch(new Request('https://person/shared-library/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: decodeURIComponent(removal[1]) }) }));
  }
  return json({ error: 'Not found' }, 404);
}
