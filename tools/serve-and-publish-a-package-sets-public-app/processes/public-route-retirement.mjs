function methodCanReadPublicRoute(method) {
  return method === 'GET' || method === 'HEAD';
}

export function shouldRetirePublicRoute({
  method,
  publicHost,
  pathname,
  exactPaths = [],
  pathPrefixes = [],
}) {
  if (!methodCanReadPublicRoute(method) || publicHost !== true || typeof pathname !== 'string') {
    return false;
  }
  const exact = Array.isArray(exactPaths) ? exactPaths : [];
  const prefixes = Array.isArray(pathPrefixes) ? pathPrefixes : [];
  return exact.some((path) => typeof path === 'string' && path.startsWith('/') && path === pathname)
    || prefixes.some((prefix) => typeof prefix === 'string' && prefix.startsWith('/') && pathname.startsWith(prefix));
}

export function replyRetiredPublicRoute(req, res) {
  const body = 'Not found\n';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
