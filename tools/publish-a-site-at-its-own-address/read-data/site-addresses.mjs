/** A name a person typed, checked; throws a plain refusal from public-app-names.json words. */
export function checkedPublicAppName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (!PATTERN.test(name) || name.includes('--') || INSTALL.test(name)) throw new Error(names.words.refused);
  if (RESERVED.has(name)) throw new Error(names.words.reserved);
  return name;
}

/** The app's name basis and where it came from: its page title, else the readable app id. */
export function publicAppNameBasis({ indexHtml = '', appId = '' } = {}) {
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(indexHtml)?.[1]
    ?.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&[a-z]+;/g, ' ').split(/\s[|·—–-]\s/)[0];
  const fromTitle = title && nameFromWords(title, { first: names.first_words, longest: names.longest, pattern: PATTERN });
  if (fromTitle && !RESERVED.has(fromTitle)) return { name: fromTitle, source: 'title' };
  const fromId = nameFromWords(String(appId).replace(/\b\d{6,}\b/g, ' '), { first: names.first_words, longest: names.longest, pattern: PATTERN });
  return fromId && !RESERVED.has(fromId) ? { name: fromId, source: 'fallback' } : null;
}

