// The signed-in workspace's private response read and reaction toggle. The person
// store owns both the record and the mutation; this is only its same-origin bridge.
export const isWorkResponsesPath = path => path === '/work/api/responses' || path === '/work/api/responses/react';

export async function handleWorkResponses(request, { person, origin }) {
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  const url = new URL(request.url);
  const read = request.method === 'GET' && url.pathname === '/work/api/responses';
  const react = request.method === 'POST' && url.pathname === '/work/api/responses/react';
  if (!read && !react) return Response.json({ error: 'Not found.' }, { status: 404 });
  const target = read
    ? new URL(`https://person/responses?${url.searchParams}`)
    : new URL('https://person/responses/react');
  return person.fetch(new Request(target, {
    method: request.method,
    headers: { 'x-trillion-origin': origin, 'x-trillion-app': 'Trillion', ...(react ? { 'content-type': 'application/json' } : {}) },
    ...(react ? { body: await request.text() } : {}),
  }));
}
