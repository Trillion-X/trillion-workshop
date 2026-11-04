// Browser AI-work routes use the same addressed screen and handoff owner as the
// native account tools. The caller supplies its authenticated browser claims.
const PERSON_WORK = new Set(['take', 'finish', 'follow-up', 'withdraw-waiting']);

export function browserWorkCommand(path, method, body, query = {}) {
  if (path === '/ai-work' && method === 'GET') {
    return ['screens:aiWork', {
      ...(query.before ? { before: query.before } : {}),
      ...(query.limit !== undefined && query.limit !== null && query.limit !== '' ? { limit: Number(query.limit) } : {}),
      ...(query.fields ? { fields: query.fields } : {}),
      rows: 'screen',
    }];
  }

  const verb = /^\/job-run\/(take|finish|follow-up|withdraw-waiting)$/.exec(path)?.[1];
  if (verb && method === 'POST' && PERSON_WORK.has(verb)) {
    return ['screens:personWork', { ...body, verb }];
  }
  return null;
}
