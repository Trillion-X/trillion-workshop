const CRITICAL_STYLE_ATTRIBUTE = 'data-bitfield-entry-critical';

function hasCriticalStyleAttribute(openingTag) {
  const attributes = openingTag
    .replace(/^<style\b/i, '')
    .replace(/>$/, '');
  return new RegExp(
    `(?:^|\\s)${CRITICAL_STYLE_ATTRIBUTE}`
      + `(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+))?`
      + '(?=\\s|$)',
    'i',
  ).test(attributes);
}

// The browser replaces the entry root when its current scene paints. Anything marked as
// critical to that entry therefore belongs in <head>, outside the replaceable region. Parse
// complete style elements first, then reject any marker left behind: a leftover marker means
// the markup was malformed or attached to something other than a complete <style> element.
export function liftPersistentEntryStyles(rootHtml) {
  const persistentStyles = [];
  const replaceableRootHtml = String(rootHtml ?? '').replace(
    /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    (style) => {
      const openingTag = style.slice(0, style.indexOf('>') + 1);
      if (!hasCriticalStyleAttribute(openingTag)) return style;
      persistentStyles.push(style);
      return '';
    },
  );

  if (new RegExp(CRITICAL_STYLE_ATTRIBUTE, 'i').test(replaceableRootHtml)) {
    throw new Error('critical entry style marker must belong to a complete style element');
  }

  return { persistentStyles, replaceableRootHtml };
}
