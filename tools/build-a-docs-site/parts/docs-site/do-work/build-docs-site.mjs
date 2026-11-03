// parts/docs-site/do-work/build-docs-site.mjs
//
// Purpose: turn one person's docs manifest (site facts, navigation, pages, two colour palettes) into the complete set
//   of files a Mintlify docs site is made of: docs.json, theme.css, theme.js, llms.txt and every page as MDX. The
//   person's AI saves those files ({ path, text } each) and pushes them to the person's own repository, connected to the person's own Mintlify project.
//
// Non-negotiable invariants:
//   1. Pure: nothing is read from disk or the network and nothing is kept. Same manifest in, same files out.
//   2. It names no product, page, group, tab or colour. Navigation, words and colours are all the caller's DATA, and
//      CSS variable names are the palette's own names under the caller's prefix.
//   3. Nothing is guessed. A missing field, a page listed twice, or a listed page with no title, description or body
//      is returned as a problem in plain words, and no files are returned until every problem is fixed.
//   4. A page's title and description are written into its own frontmatter, never copied anywhere else, so llms.txt
//      and the page can never disagree.
//
// PORTED FROM: Trillion-X/trillion-docs scripts/generate-docs.mjs (itself adapted from dev/bitfield-docs
//   scripts/generate-docs.mjs). Changed only the seam: inputs arrive as one value instead of files, outputs return as
//   { files } instead of being written, and the Trillion look lookup moved to the caller (palettes are given).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const REQUIRED_SITE = ['name', 'description', 'url'];

const routesOf = navigation => navigation.flatMap(tab => tab.groups.flatMap(group => group.pages));
const quote = text => JSON.stringify(String(text));

/** Checks one manifest and lists every problem at once, in plain words. */
export function docsSiteProblems(manifest) {
  const problems = [];
  const site = manifest?.site ?? {};
  for (const field of REQUIRED_SITE) if (!site[field]) problems.push(`site.${field} is missing`);
  const navigation = Array.isArray(manifest?.navigation) ? manifest.navigation : [];
  if (!navigation.length) problems.push('navigation has no tabs');
  for (const tab of navigation) {
    if (!tab?.tab) problems.push('a tab has no name');
    if (!Array.isArray(tab?.groups) || !tab.groups.length) problems.push(`tab ${tab?.tab ?? '(unnamed)'} has no groups`);
    for (const group of tab?.groups ?? []) {
      if (!group?.group) problems.push(`a group in tab ${tab.tab} has no name`);
      if (!Array.isArray(group?.pages) || !group.pages.length) problems.push(`group ${group?.group ?? '(unnamed)'} has no pages`);
    }
  }
  const routes = routesOf(navigation.filter(tab => Array.isArray(tab?.groups)).map(tab => ({ groups: tab.groups.filter(group => Array.isArray(group?.pages)) })));
  for (const route of new Set(routes.filter((route, index) => routes.indexOf(route) !== index))) problems.push(`${route} is listed more than once`);
  const pages = new Map((manifest?.pages ?? []).map(page => [page?.route, page]));
  for (const route of routes) {
    if (!/^[a-z0-9][a-z0-9/_-]*$/.test(route ?? '')) { problems.push(`${route} is not a page address (lowercase letters, digits, - _ /)`); continue; }
    const page = pages.get(route);
    if (!page) { problems.push(`${route} is in the navigation but has no page`); continue; }
    for (const field of ['title', 'description', 'body']) if (!page[field]) problems.push(`${route} has no ${field}`);
  }
  for (const mode of ['light', 'dark']) {
    const palette = manifest?.palettes?.[mode];
    if (!palette || typeof palette !== 'object' || !Object.keys(palette).length) problems.push(`palettes.${mode} is missing`);
  }
  const roles = manifest?.roles ?? {};
  for (const role of ['accent', 'page']) if (!roles[role]) problems.push(`roles.${role} is missing (the palette entry for the ${role === 'accent' ? 'main accent' : 'page background'} colour)`);
  for (const mode of ['light', 'dark']) for (const role of ['accent', 'page']) {
    if (roles[role] && manifest?.palettes?.[mode] && !(roles[role] in manifest.palettes[mode])) problems.push(`palettes.${mode} has no ${roles[role]}`);
  }
  return problems;
}

/** manifest → { files: [{ path, text }], problems: [] } or { files: [], problems: [text] }. See docsSiteProblems. */
export function buildDocsSite(manifest) {
  const problems = docsSiteProblems(manifest);
  if (problems.length) return { files: [], problems };
  const { site, navigation, palettes, roles } = manifest;
  const prefix = (manifest.variable_prefix ?? 'site').replace(/[^a-z0-9-]/gi, '');
  const pageByRoute = new Map(manifest.pages.map(page => [page.route, page]));
  const routes = routesOf(navigation);
  const colour = (mode, role) => palettes[mode][roles[role]];
  const url = site.url.replace(/\/+$/, '');
  const social = site.social ?? {};
  const fontFaces = site.font_faces ?? [];
  const fontOf = choice => {
    if (!choice) return undefined;
    const face = fontFaces.find(candidate => candidate.family === choice.family && candidate.weight === choice.weight);
    return face ? { family: choice.family, weight: choice.weight, source: face.source, format: face.format ?? 'woff2' } : { family: choice.family, weight: choice.weight };
  };

  const docsJson = {
    $schema: 'https://mintlify.com/docs.json',
    theme: site.theme ?? 'mint',
    name: site.name,
    description: site.description,
    colors: {
      primary: colour('light', 'accent'),
      light: colour('dark', 'accent'),
      dark: roles.accent_strong ? palettes.light[roles.accent_strong] ?? colour('light', 'accent') : colour('light', 'accent'),
    },
    background: { color: { light: colour('light', 'page'), dark: colour('dark', 'page') } },
    appearance: { default: site.appearance ?? 'system', strict: false },
    ...(site.logo ? { logo: { light: site.logo.light, dark: site.logo.dark ?? site.logo.light, href: url } } : {}),
    ...(site.favicon ? { favicon: site.favicon } : {}),
    ...(site.fonts ? { fonts: Object.fromEntries(Object.entries(site.fonts).map(([use, choice]) => [use, fontOf(choice)])) } : {}),
    search: { prompt: site.search_prompt ?? `Search ${site.name} docs...` },
    metadata: { timestamp: true },
    seo: {
      indexing: 'navigable',
      metatags: {
        canonical: url,
        description: social.description ?? site.description,
        ...(site.keywords?.length ? { keywords: site.keywords.join(', ') } : {}),
        robots: 'index, follow',
        'application-name': site.name,
        'og:site_name': social.site_name ?? site.name,
        'og:type': 'website',
        'og:url': url,
        'og:title': social.title ?? site.name,
        'og:description': social.description ?? site.description,
        ...(social.image ? { 'og:image': social.image, 'twitter:image': social.image, 'twitter:card': 'summary_large_image' } : {}),
        ...(social.image_alt ? { 'og:image:alt': social.image_alt, 'twitter:image:alt': social.image_alt } : {}),
      },
    },
    ...(site.navbar ? {
      navbar: {
        links: (site.navbar.links ?? []).map(({ label, href }) => ({ label, href })),
        ...(site.navbar.primary ? { primary: { type: 'button', label: site.navbar.primary.label, href: site.navbar.primary.href } } : {}),
      },
    } : {}),
    navigation: { tabs: navigation.map(tab => ({ tab: tab.tab, groups: tab.groups.map(group => ({ group: group.group, pages: [...group.pages] })) })) },
    ...(site.contextual?.length ? { contextual: { options: [...site.contextual] } } : {}),
  };

  const variables = palette => Object.entries(palette).map(([name, value]) => `  --${prefix}-${name.replace(/^--/, '')}: ${value};`).join('\n');
  const themeCss = [
    '/* Generated from the docs manifest. Change the manifest and build again; do not edit this file. */',
    ...fontFaces.map(face => `@font-face {\n  font-family: ${quote(face.family)};\n  src: url(${quote(face.source)}) format(${quote(face.format ?? 'woff2')});\n  font-style: normal;\n  font-weight: ${face.weight};\n  font-display: swap;\n}`),
    `:root {\n  color-scheme: light;\n${variables(palettes.light)}\n}`,
    `html.dark {\n  color-scheme: dark;\n${variables(palettes.dark)}\n}`,
  ].join('\n\n');

  const themeJs = `// Generated from the docs manifest: the browser bar follows the page colour as light and dark switch.
(() => {
  const colours = ${JSON.stringify({ light: colour('light', 'page'), dark: colour('dark', 'page') })};
  const root = document.documentElement;
  const paint = () => {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    meta.content = root.classList.contains('dark') ? colours.dark : colours.light;
  };
  paint();
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['class'] });
})();
`;

  const llms = [
    `# ${social.site_name ?? site.name}`,
    '',
    `> ${site.description}`,
    '',
    ...navigation.flatMap(tab => tab.groups.flatMap(group => [
      `## ${group.group === tab.tab ? tab.tab : `${tab.tab}: ${group.group}`}`,
      '',
      ...group.pages.map(route => {
        const page = pageByRoute.get(route);
        return `- [${page.title}](${url}/${route === 'index' ? '' : route}): ${page.description}`;
      }),
      '',
    ])),
    ...(site.navbar?.primary ? [`${site.navbar.primary.label}: ${site.navbar.primary.href}`] : []),
  ].join('\n');

  const files = {
    'docs.json': `${JSON.stringify(docsJson, null, 2)}\n`,
    'theme.css': `${themeCss}\n`,
    'theme.js': themeJs,
    'llms.txt': `${llms}\n`,
  };
  for (const route of routes) {
    const page = pageByRoute.get(route);
    files[`${route}.mdx`] = `---\ntitle: ${quote(page.title)}\ndescription: ${quote(page.description)}\n---\n\n${page.body.trim()}\n`;
  }
  return { files: Object.entries(files).map(([path, text]) => ({ path, text })), problems: [] };
}
