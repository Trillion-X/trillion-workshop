// Give every web source one stable URL and file root. The installed site keeps
// its existing routes; additional sources live below their source key.
export function webSourceMounts(sources) {
  const web = [...sources].filter(source => source.targets.includes('web') &&
    source.project.outputs.some(output => output.target === 'web' && output.status !== 'unsupported'))
    .sort((a, b) => a.key.localeCompare(b.key));
  const root = web.find(source => source.key === 'site') ?? web[0];
  return new Map(web.map(source => [source.key, source === root ? '' : `/${source.key}`]));
}

export function mountedWebRoute(mount, route) {
  if (!mount) return route;
  return route === '/' ? `${mount}/` : `${mount}${route}`;
}

export function mountedWebFile(mount, path) {
  return mount ? `${mount.slice(1)}/${path}` : path;
}
