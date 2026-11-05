  // Which page builds may keep working (src/client-version.mjs): the Worker's own DATA, no store request.
  if (request.method === 'GET' && url.pathname === '/work/api/client-version') return json(clientVersionAnswer());
