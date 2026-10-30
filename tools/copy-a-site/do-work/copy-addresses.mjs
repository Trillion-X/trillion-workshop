// Address rules shared by the cloud copier and the browser that joins completed batches.
const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g;
const segment = value => (decodeURIComponent(value).replace(SAFE_SEGMENT, '-').replace(/^[.-]+/, '') || 'x');

export function pageFile(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(segment);
  if (!parts.length) return 'index.html';
  return /\.html?$/i.test(parts.at(-1)) ? parts.join('/') : [...parts, 'index.html'].join('/');
}

// Known copied addresses become local. Unknown ones retain their original site address.
export function rewrite(text, origin, fileOf) {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const absolute = new RegExp(`${escaped}(/[^"'\\s)<>]*)?`, 'g');
  const replaceKnown = part => part.replace(absolute, (_, rest = '/') => fileOf(rest) ?? origin + rest)
    .replace(/((?:src|href|poster)=["'])(\/[^"'#]*)/g, (whole, lead, path) => lead + (fileOf(path) ?? origin + path))
    .replace(/url\((['"]?)(\/[^'")]+)\1\)/g, (whole, quote, path) => 'url(' + quote + (fileOf(path) ?? origin + path) + quote + ')');
  return text.split(/(<a\b[^>]*\bdata-site-copy-original\b[^>]*>)/gi)
    .map((part, index) => index % 2 ? part : replaceKnown(part)).join('');
}
