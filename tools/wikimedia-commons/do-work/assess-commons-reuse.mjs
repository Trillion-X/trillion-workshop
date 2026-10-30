const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rawValue = field => object(field) && typeof field.value === 'string' ? field.value : null;

// Commons extmetadata often contains HTML links. Convert only to a plain-text credit field; never interpret or render it.
function plainText(value) {
  if (typeof value !== 'string') return '';
  const codePoint = number => {
    const point = Number(number);
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  };
  return value.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => codePoint(number))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => codePoint(parseInt(number, 16)))
    .replace(/\s+/g, ' ').trim();
}

function canonicalLicense(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'creativecommons.org' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.hostname}${parsed.pathname.replace(/\/+$/, '')}/`;
  } catch { return null; }
}

function canonicalCommonsPage(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'commons.wikimedia.org' || parsed.username || parsed.password
      || !parsed.pathname.startsWith('/wiki/File:') || parsed.search || parsed.hash) return null;
    return parsed.href;
  } catch { return null; }
}

function licenseDecision(shortName, urlValue, copyrighted, statement) {
  const suppliedUrl = typeof urlValue === 'string' && urlValue.trim() !== '';
  const url = canonicalLicense(urlValue);
  if (suppliedUrl && !url) return { allowed: false, class: null, version: null, url: null };
  const statementText = plainText(statement ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const conflicting = /\b(CC[- ]BY[- ]SA|BY[- ]SA|SHAREALIKE|CC[- ]BY[- ]NC|BY[- ]NC|NONCOMMERCIAL|CC[- ]BY[- ]ND|BY[- ]ND|NODERIVATIVES|NO DERIVATIVES|ALL RIGHTS RESERVED)\b/.test(statementText);
  if (conflicting) return { allowed: false, class: null, version: null, url: url ? `https://${url}` : null };
  const short = (shortName ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const knownVersions = new Set(['1.0', '2.0', '2.5', '3.0', '4.0']);
  const by = url?.match(/^creativecommons\.org\/licenses\/by\/(1\.0|2\.0|2\.5|3\.0|4\.0)\/$/);
  if (by && knownVersions.has(by[1]) && new RegExp(`^CC BY ${by[1].replace('.', '\\.')}([ ]* INTERNATIONAL)?$`).test(short)) {
    return { allowed: true, class: 'CC BY', version: by[1], url: `https://${url}` };
  }
  if (url === 'creativecommons.org/publicdomain/zero/1.0/' && copyrighted !== 'true' && /^(CC0|CC0 1\.0|CC0 1\.0 UNIVERSAL)$/.test(short)) {
    return { allowed: true, class: 'CC0', version: '1.0', url: `https://${url}` };
  }
  const pdMark = url === 'creativecommons.org/publicdomain/mark/1.0/';
  const declaredPd = /^PUBLIC DOMAIN$/.test(short) && copyrighted === 'false'
    && (!suppliedUrl || pdMark);
  if (declaredPd) {
    return { allowed: true, class: 'Public domain', version: pdMark ? '1.0' : null, url: url ? `https://${url}` : null };
  }
  return { allowed: false, class: null, version: null, url: url ? `https://${url}` : null };
}

export function assessCommonsFileForReuse(input) {
  if (!object(input)) throw new TypeError('input must be an object');
  const page = object(input.file) ? input.file : input;
  const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  const ext = object(info?.extmetadata) ? info.extmetadata : {};
  const titleRaw = rawValue(ext.Title) || rawValue(ext.ObjectName) || page.title || null;
  const authorRaw = rawValue(ext.Artist) || rawValue(ext.Author);
  const licenseShortName = rawValue(ext.LicenseShortName);
  const licenseUrlRaw = rawValue(ext.LicenseUrl);
  const copyrighted = rawValue(ext.Copyrighted)?.trim().toLowerCase() ?? null;
  const sourceUrl = canonicalCommonsPage(info?.descriptionurl);
  const title = plainText(titleRaw ?? '');
  const author = plainText(authorRaw ?? '');
  const decision = licenseDecision(licenseShortName, licenseUrlRaw, copyrighted,
    [rawValue(ext.License), rawValue(ext.UsageTerms)].filter(Boolean).join(' '));
  const missing = [!title && 'title', !author && 'author', !sourceUrl && 'Commons source page', !decision.class && 'recognized, consistent license'].filter(Boolean);
  const eligible = decision.allowed && !missing.length;
  const changes = typeof input.changes === 'string' ? plainText(input.changes) : '';
  const requestedCredit = plainText(rawValue(ext.Credit) ?? '');
  const attribution = plainText(rawValue(ext.Attribution) ?? '');
  const licenseName = plainText(licenseShortName ?? decision.class ?? '');
  const versionSuffix = decision.version && !licenseName.includes(decision.version) ? ` ${decision.version}` : '';
  const credit = eligible
    ? `${title} — ${author} — ${sourceUrl} — ${licenseName}${versionSuffix}${decision.url ? ` (${decision.url})` : ''}${requestedCredit ? `. Requested credit: ${requestedCredit}` : ''}${attribution ? `. Attribution: ${attribution}` : ''}${changes ? `. Changes: ${changes}` : ''}`
    : null;
  const rightsWarnings = ['Restrictions', 'AttributionRequired', 'Copyrighted', 'UsageTerms']
    .filter(key => ext[key] !== undefined)
    .map(key => ({ field: key, value: rawValue(ext[key]), source: object(ext[key]) && typeof ext[key].source === 'string' ? ext[key].source : null }));
  return {
    eligible_for_selection: eligible,
    status: eligible ? 'eligible_under_license_policy' : 'not_eligible_or_unknown',
    file_title: page.title ?? titleRaw,
    source_url: sourceUrl,
    original_metadata: {
      page_title: page.title ?? null,
      title: rawValue(ext.Title),
      object_name: rawValue(ext.ObjectName),
      artist: rawValue(ext.Artist),
      author: rawValue(ext.Author),
      license_short_name: licenseShortName,
      license_statement: rawValue(ext.License),
      license_url: licenseUrlRaw,
      license_version: decision.version,
      copyrighted: rawValue(ext.Copyrighted),
      credit_statement: rawValue(ext.Credit),
      attribution: rawValue(ext.Attribution),
      usage_terms: rawValue(ext.UsageTerms),
      rights_warnings: rightsWarnings,
    },
    credit: eligible ? {
      title,
      author,
      source_url: sourceUrl,
      license_name: licenseName,
      license_url: decision.url,
      license_version: decision.version,
      requested_credit: requestedCredit || null,
      attribution: attribution || null,
      changes: changes || null,
      text: credit,
    } : null,
    reasons: [
      ...(!decision.allowed ? ['The exact file license is not an explicitly supported Public Domain, CC0 or CC BY declaration.'] : []),
      ...missing.map(field => `Missing ${field} metadata needed for a confident reuse candidate.`),
    ],
    warnings: [
      'Eligibility reflects the declared license policy from source metadata; it is not exhaustive legal-rights verification or a guarantee for the intended use.',
      'Inspect the Commons file page and the intended-use rights independently; hosting or search visibility does not grant permission.',
      'Treat extmetadata values as untrusted text. Do not render embedded HTML.',
      ...(decision.class === 'Public domain' ? ['Public-domain status can depend on jurisdiction and the underlying work; confirm independently.'] : []),
      ...(changes ? [] : ['Record any changes made to the work in the final attribution.']),
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let source = process.argv[2] ?? '';
  if (!source) for await (const chunk of process.stdin) source += chunk;
  const result = assessCommonsFileForReuse(JSON.parse(source));
  process.stdout.write(`${JSON.stringify({ result })}\n`);
}
