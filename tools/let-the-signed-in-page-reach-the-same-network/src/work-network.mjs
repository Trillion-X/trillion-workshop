// The signed-in workspace uses the same network owner as connected AIs.
const json = (value, status = 200) => Response.json(value, { status });
const allowed = new Set(['GET ', 'GET people', 'GET person', 'GET on-your-path', 'PUT profile', 'POST find', 'POST request', 'POST answer', 'GET ai-pings', 'PUT ai-pings', 'POST ai-pings', 'GET stays', 'PUT stays', 'POST stays/ask', 'GET stays/request']);

export const isWorkNetworkPath = path => path === '/work/api/network' || path.startsWith('/work/api/network/');

export async function handleWorkNetwork(request, { person, origin, url }) {
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
  const rest = url.pathname.slice('/work/api/network'.length);
  const route = `${request.method} ${rest.replace(/^\//, '')}`;
  if (!allowed.has(route)) return json({ error: 'Not found' }, 404);
  return person.fetch(new Request(`https://person/network${rest}${request.method === 'GET' ? url.search : ''}`, {
    method: request.method,
    headers: { 'content-type': 'application/json', 'x-trillion-origin': origin },
    ...(request.method === 'GET' ? {} : { body: await request.text() }),
  }));
}
